import asyncio
import os
import shutil
import re
import time
import json
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
import httpx
import requests
import concurrent.futures

import database

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

SITEMAP_URL = "https://www.statsarena.site/sitemap-matches.xml"
API_BASE_URL = "https://statsarena-v2-backend.onrender.com/api/v2/predictions/match"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.statsarena.site",
    "Referer": "https://www.statsarena.site/"
}

# Thread-safe live status — read-only from other threads is safe for dicts
scraper_live_state: Dict[str, Any] = {
    "is_running": False,
    "status_text": "Idle",
    "phase": "idle",
    "total_urls": 0,
    "processed_count": 0,
    "new_count": 0,
    "updated_count": 0,
    "error_count": 0,
    "start_time": None,
    "duration_seconds": 0,
    "last_finished_time": None
}

def get_live_state() -> Dict[str, Any]:
    return dict(scraper_live_state)  # Return a shallow copy to avoid mutation


def get_initials(name: str) -> str:
    """Generate 2-letter initials for players/teams."""
    if not name:
        return "??"
    parts = [p.strip() for p in name.replace(".", " ").replace("-", " ").split() if p.strip()]
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    elif len(parts) == 1:
        return parts[0][:2].upper()
    return "??"


def clean_league_and_location(league_raw: str, sport: str) -> tuple[str, str]:
    """Parse league string and extract tour name and location/city."""
    if not league_raw:
        return "Unknown League", ""

    league = league_raw.strip()
    location = ""

    # Use em-dash first, then en-dash, then regular dash
    for separator in ["—", "–", " - "]:
        if separator in league:
            parts = league.split(separator, 1)
            league = parts[0].strip()
            location = parts[1].strip() if len(parts) > 1 else ""
            break

    if sport == "tennis":
        league_upper = league.upper()
        if "CHALLENGER-MEN" in league_upper or "CHALLENGER MEN" in league_upper:
            league = "ATP Challenger"
        elif "CHALLENGER-WOMEN" in league_upper or "CHALLENGER WOMEN" in league_upper:
            league = "WTA 125K"
        elif "ATP" in league_upper:
            league = "ATP Tour"
        elif "WTA" in league_upper:
            league = "WTA Tour"
        elif "ITF" in league_upper:
            league = "ITF Circuit"

    return league, location


def extract_match_id(url: str) -> str:
    parts = url.rstrip("/").split("/")
    return parts[-1] if parts else ""


def determine_sport(url: str, match_id: str) -> str:
    url_lower = url.lower()
    if match_id.startswith("t") or any(k in url_lower for k in [
        "/atp/", "/wta/", "/challenger-men/", "/challenger-women/", "/itf/", "/tennis/"
    ]):
        return "tennis"
    return "football"


def parse_iso_time(time_str: Optional[str]) -> tuple[str, int]:
    if not time_str:
        now = datetime.now(timezone.utc)
        return now.isoformat(), int(now.timestamp())
    try:
        clean_str = time_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean_str)
        return dt.isoformat(), int(dt.timestamp())
    except (ValueError, TypeError):
        now = datetime.now(timezone.utc)
        return time_str, int(now.timestamp())


def calculate_ev(prob_pct: Optional[float], decimal_odds: Optional[float]) -> float:
    """
    Core EV calculation:
    EV = p * O - 1
    where:
      p = model estimated win probability (as decimal 0.0 - 1.0)
      O = decimal market odds
      EV > 0 = profitable expected value (+EV)
    Returns EV edge percentage rounded to 1 decimal place (e.g. 10.0 for +10.0% EV)
    """
    if prob_pct is None or decimal_odds is None or decimal_odds <= 1.0 or prob_pct <= 0:
        return 0.0
    p = float(prob_pct) / 100.0
    ev = (p * float(decimal_odds)) - 1.0
    return round(ev * 100.0, 1)


def determine_value_bet(
    sport: str,
    home_prob: Optional[float], away_prob: Optional[float], draw_prob: Optional[float],
    m_home: Optional[float], m_away: Optional[float], m_draw: Optional[float]
) -> tuple[int, Optional[str], float]:
    """
    EV Value Bet Logic:
    Always looks for an expected value edge on the HIGHEST PROBABLE player/team (favorite).
    Only returns a value bet if the most likely winner offers positive expected value (EV > 0).
    """
    hp = float(home_prob or 0.0)
    ap = float(away_prob or 0.0)
    dp = float(draw_prob or 0.0)

    if hp == 0 and ap == 0 and dp == 0:
        return 0, None, 0.0

    # 1. Tennis (2-way) or football without draw prob
    if sport == "tennis" or not draw_prob:
        if hp > ap:
            fav_side, prob, odds = "home", hp, m_home
        elif ap > hp:
            fav_side, prob, odds = "away", ap, m_away
        else:
            # 50-50 tie break: check which 50% player has better +EV
            ev_h = calculate_ev(hp, m_home)
            ev_a = calculate_ev(ap, m_away)
            if max(ev_h, ev_a) > 0:
                side = "home" if ev_h >= ev_a else "away"
                return 1, side, max(ev_h, ev_a)
            return 0, None, 0.0

    # 2. Football (3-way)
    else:
        max_p = max(hp, dp, ap)
        if max_p == hp:
            fav_side, prob, odds = "home", hp, m_home
        elif max_p == ap:
            fav_side, prob, odds = "away", ap, m_away
        else:
            fav_side, prob, odds = "draw", dp, m_draw

    ev = calculate_ev(prob, odds)
    if ev > 0:
        return 1, fav_side, ev

    return 0, None, 0.0


def _safe_round(val: Any, decimals: int) -> Any:
    """Safely round a value, returning None for non-numeric inputs."""
    if val is None:
        return None
    try:
        return round(float(val), decimals)
    except (ValueError, TypeError):
        return None


def _extract_odds_data(data: dict) -> dict:
    """Extract and normalize odds & probability data from API response."""
    market_odds = (data.get("market_odds") or {}).get("1x2") or {}
    market_dec = market_odds.get("decimal") or {}
    model_odds = (data.get("model_odds") or {}).get("1x2") or {}
    model_dec = model_odds.get("decimal") or {}

    model_probs = model_odds.get("probability_pct") or {}
    h_prob = model_probs.get("home")
    d_prob = model_probs.get("draw")
    a_prob = model_probs.get("away")

    # Fallback to market-implied probability
    if h_prob is None and a_prob is None:
        m_probs = market_odds.get("probability_pct") or {}
        h_prob = m_probs.get("home")
        d_prob = m_probs.get("draw")
        a_prob = m_probs.get("away")

    return {
        "m_home": market_dec.get("home"),
        "m_draw": market_dec.get("draw"),
        "m_away": market_dec.get("away"),
        "f_home": model_dec.get("home"),
        "f_draw": model_dec.get("draw"),
        "f_away": model_dec.get("away"),
        "h_prob": h_prob,
        "d_prob": d_prob,
        "a_prob": a_prob,
    }


def fetch_match_data(session: requests.Session, url: str) -> Optional[Dict[str, Any]]:
    match_id = extract_match_id(url)
    if not match_id:
        return None

    sport = determine_sport(url, match_id)
    api_url = f"{API_BASE_URL}/{match_id}"

    for attempt in range(2):
        try:
            resp = session.get(api_url, timeout=12)
            if resp.status_code == 200:
                data = resp.json()
                if not data or not isinstance(data, dict):
                    return None

                league_raw = data.get("league") or data.get("tournament_name") or ""
                league, location = clean_league_and_location(league_raw, sport)
                if not location and data.get("location"):
                    location = data.get("location")
                home_name = data.get("home_team") or "Home"
                away_name = data.get("away_team") or "Away"

                avatars = data.get("contender_avatar") or {}
                home_avatar = avatars.get("home") or ""
                away_avatar = avatars.get("away") or ""

                start_time_iso, start_timestamp = parse_iso_time(data.get("start_time"))

                odds = _extract_odds_data(data)
                r_hp = _safe_round(odds["h_prob"], 1)
                r_dp = _safe_round(odds["d_prob"], 1)
                r_ap = _safe_round(odds["a_prob"], 1)
                r_mh = _safe_round(odds["m_home"], 2)
                r_md = _safe_round(odds["m_draw"], 2)
                r_ma = _safe_round(odds["m_away"], 2)

                has_val, val_side, val_edge = determine_value_bet(
                    sport,
                    r_hp, r_ap, r_dp,
                    r_mh, r_ma, r_md
                )

                time.sleep(0.04)
                return {
                    "id": match_id,
                    "url": url,
                    "sport": sport,
                    "league": league,
                    "location": location,
                    "home_name": home_name,
                    "away_name": away_name,
                    "home_initials": get_initials(home_name),
                    "away_initials": get_initials(away_name),
                    "home_avatar": home_avatar,
                    "away_avatar": away_avatar,
                    "start_time": start_time_iso,
                    "start_timestamp": start_timestamp,
                    "home_prob": r_hp,
                    "draw_prob": r_dp,
                    "away_prob": r_ap,
                    "market_home": r_mh,
                    "market_draw": r_md,
                    "market_away": r_ma,
                    "fair_home": _safe_round(odds["f_home"], 2),
                    "fair_draw": _safe_round(odds["f_draw"], 2),
                    "fair_away": _safe_round(odds["f_away"], 2),
                    "has_value": has_val,
                    "value_side": val_side,
                    "value_edge": val_edge,
                    "raw_json": json.dumps(data)
                }

            elif resp.status_code == 429:
                logger.warning(f"Rate limited on {match_id}, sleeping 2s (attempt {attempt + 1}/2)")
                time.sleep(2.0)

            elif resp.status_code == 404:
                logger.debug(f"Match {match_id} not found (404)")
                return None

            else:
                time.sleep(0.5)

        except Exception as e:
            logger.warning(f"Fetch note for {match_id}: {e}")
            time.sleep(0.8)

    return None


def fetch_sitemap_urls() -> List[str]:
    session = requests.Session()
    session.trust_env = False
    for attempt in range(3):
        try:
            resp = session.get(SITEMAP_URL, headers=HEADERS, timeout=25)
            resp.raise_for_status()
            root = ET.fromstring(resp.content)
            namespaces = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
            locs = []
            for elem in root.findall(".//sm:loc", namespaces):
                if elem.text and elem.text.strip():
                    locs.append(elem.text.strip())
            if not locs:
                for elem in root.findall(".//loc"):
                    if elem.text and elem.text.strip():
                        locs.append(elem.text.strip())
            if locs:
                return locs
        except Exception as e:
            logger.warning(f"Sitemap fetch attempt {attempt + 1}/3 note: {e}")
            time.sleep(1.5)

    raise RuntimeError("Failed to fetch sitemap from StatsArena after 3 attempts")


async def run_scraper_pipeline() -> Dict[str, Any]:
    global scraper_live_state

    database.init_db()
    start_time = time.time()
    timestamp_iso = datetime.now(timezone.utc).isoformat()

    scraper_live_state.update({
        "is_running": True,
        "phase": "fetching_sitemap",
        "status_text": "Fetching sitemap XML...",
        "start_time": timestamp_iso,
        "processed_count": 0,
        "new_count": 0,
        "updated_count": 0,
        "error_count": 0,
    })

    logger.info("Starting StatsArena scraper...")

    try:
        urls = fetch_sitemap_urls()
    except Exception as e:
        logger.error(f"Failed to fetch sitemap: {e}")
        duration = round(time.time() - start_time, 2)
        scraper_live_state.update({
            "is_running": False,
            "phase": "error",
            "status_text": f"Error: {e}",
            "error_count": 1,
            "duration_seconds": duration,
        })
        database.record_scraper_run({
            "timestamp": timestamp_iso,
            "total_urls": 0, "scraped_matches": 0, "new_matches": 0,
            "updated_matches": 0, "errors": 1,
            "duration_seconds": round(time.time() - start_time, 2),
            "status": f"Error: {e}"
        })
        return {"status": "error", "message": str(e)}

    # Collect active IDs from sitemap
    active_sitemap_ids = set()
    for u in urls:
        mid = extract_match_id(u)
        if mid:
            active_sitemap_ids.add(mid)

    # Sync finished matches that dropped out of the sitemap
    finished_moved = database.sync_finished_matches(active_sitemap_ids)
    if finished_moved > 0:
        logger.info(f"Archived {finished_moved} completed matches to finished section.")

    session = requests.Session()
    session.trust_env = False
    adapter = requests.adapters.HTTPAdapter(pool_connections=12, pool_maxsize=12, max_retries=2)
    session.mount('https://', adapter)
    session.headers.update(HEADERS)

    results: List[Optional[Dict[str, Any]]] = []
    chunk_size = 15

    for i in range(0, len(urls), chunk_size):
        chunk = urls[i:i + chunk_size]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            chunk_results = list(executor.map(lambda u: fetch_match_data(session, u), chunk))
            results.extend(chunk_results)

        scraper_live_state["processed_count"] = len(results)
        scraper_live_state["status_text"] = f"Scraping matches ({len(results)}/{len(urls)})..."
        time.sleep(0.2)

    scraper_live_state["phase"] = "saving"
    scraper_live_state["status_text"] = "Saving match records to database..."

    valid_results = [r for r in results if r and isinstance(r, dict)]
    errors_count = len(results) - len(valid_results)

    try:
        new_count, updated_count = database.upsert_matches_batch(valid_results)
    except Exception as e:
        logger.error(f"Batch upsert error: {e}")
        new_count, updated_count = 0, 0
        errors_count += len(valid_results)

    duration = round(time.time() - start_time, 2)
    scraped = new_count + updated_count
    status_msg = f"Finished: {scraped} matches ({new_count} new, {updated_count} refreshed, {errors_count} errors) in {duration}s"

    database.record_scraper_run({
        "timestamp": timestamp_iso,
        "total_urls": len(urls),
        "scraped_matches": scraped,
        "new_matches": new_count,
        "updated_matches": updated_count,
        "errors": errors_count,
        "duration_seconds": duration,
        "status": status_msg
    })

    # Export static data.json for GitHub hosting
    try:
        export_static_json()
    except Exception as e:
        logger.warning(f"Static JSON export warning: {e}")

    scraper_live_state.update({
        "is_running": False,
        "phase": "finished",
        "status_text": status_msg,
        "new_count": new_count,
        "updated_count": updated_count,
        "error_count": errors_count,
        "duration_seconds": duration,
        "last_finished_time": datetime.now(timezone.utc).isoformat(),
    })

    logger.info(f"Scraper completed. {status_msg}")
    return {
        "status": "success",
        "total_urls": len(urls),
        "scraped_matches": scraped,
        "new_matches": new_count,
        "updated_matches": updated_count,
        "errors": errors_count,
        "duration_seconds": duration
    }


def export_static_json():
    """Export complete dataset to static/data.json for GitHub Pages hosting."""
    active_tennis = database.get_matches(sport="tennis", is_finished=0, sort_order="asc", limit=500)
    active_football = database.get_matches(sport="football", is_finished=0, sort_order="asc", limit=500)

    finished_tennis = database.get_matches(sport="tennis", is_finished=1, sort_order="desc", limit=500)
    finished_football = database.get_matches(sport="football", is_finished=1, sort_order="desc", limit=500)

    value_tennis = [m for m in active_tennis if m.get("has_value") == 1]
    value_football = [m for m in active_football if m.get("has_value") == 1]

    stats = database.get_stats()
    leagues_tennis = database.get_leagues("tennis")
    leagues_football = database.get_leagues("football")

    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "leagues": {
            "tennis": leagues_tennis,
            "football": leagues_football
        },
        "matches": {
            "tennis": active_tennis,
            "football": active_football
        },
        "value_matches": {
            "tennis": value_tennis,
            "football": value_football
        },
        "finished_matches": {
            "tennis": finished_tennis,
            "football": finished_football
        }
    }

    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, "data.json")

    # Write atomically to avoid partial reads
    tmp_file = out_file + ".tmp"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp_file, out_file)

    # Also copy to root for GitHub Pages
    root_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
    try:
        import shutil
        shutil.copy2(out_file, root_file)
    except Exception as e:
        logger.debug(f"Root data.json copy note: {e}")


def scrape_sync():
    """Synchronous entry point. Safe to call from threads — creates its own event loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(run_scraper_pipeline())
    finally:
        loop.close()


if __name__ == "__main__":
    scrape_sync()
