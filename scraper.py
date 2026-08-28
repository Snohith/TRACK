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


def determine_value_bet(
    home_prob: Optional[float], away_prob: Optional[float], draw_prob: Optional[float],
    m_home: Optional[float], m_away: Optional[float], m_draw: Optional[float],
    f_home: Optional[float], f_away: Optional[float], f_draw: Optional[float]
) -> tuple[int, Optional[str]]:
    candidates = []
    if m_home and f_home and f_home > 0 and m_home > f_home * 1.03 and (home_prob or 0) >= 20:
        candidates.append(("home", (m_home / f_home) - 1.0))
    if m_away and f_away and f_away > 0 and m_away > f_away * 1.03 and (away_prob or 0) >= 20:
        candidates.append(("away", (m_away / f_away) - 1.0))
    if m_draw and f_draw and f_draw > 0 and m_draw > f_draw * 1.03 and (draw_prob or 0) >= 20:
        candidates.append(("draw", (m_draw / f_draw) - 1.0))

    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        return 1, candidates[0][0]

    return 0, None


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


async def fetch_match_data(
    client: httpx.AsyncClient, semaphore: asyncio.Semaphore, url: str
) -> Optional[Dict[str, Any]]:
    match_id = extract_match_id(url)
    if not match_id:
        return None

    sport = determine_sport(url, match_id)
    api_url = f"{API_BASE_URL}/{match_id}"

    async with semaphore:
        for attempt in range(5):
            try:
                resp = await client.get(api_url, headers=HEADERS, timeout=14.0)

                if resp.status_code == 200:
                    data = resp.json()

                    league_raw = data.get("league") or ""
                    league, location = clean_league_and_location(league_raw, sport)

                    home_name = data.get("home_team") or "Home"
                    away_name = data.get("away_team") or "Away"

                    avatars = data.get("contender_avatar") or {}
                    home_avatar = avatars.get("home") or ""
                    away_avatar = avatars.get("away") or ""

                    start_time_iso, start_timestamp = parse_iso_time(data.get("start_time"))

                    odds = _extract_odds_data(data)

                    has_val, val_side = determine_value_bet(
                        odds["h_prob"], odds["a_prob"], odds["d_prob"],
                        odds["m_home"], odds["m_away"], odds["m_draw"],
                        odds["f_home"], odds["f_away"], odds["f_draw"]
                    )

                    await asyncio.sleep(0.12)
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
                        "home_prob": _safe_round(odds["h_prob"], 1),
                        "draw_prob": _safe_round(odds["d_prob"], 1),
                        "away_prob": _safe_round(odds["a_prob"], 1),
                        "market_home": _safe_round(odds["m_home"], 2),
                        "market_draw": _safe_round(odds["m_draw"], 2),
                        "market_away": _safe_round(odds["m_away"], 2),
                        "fair_home": _safe_round(odds["f_home"], 2),
                        "fair_draw": _safe_round(odds["f_draw"], 2),
                        "fair_away": _safe_round(odds["f_away"], 2),
                        "has_value": has_val,
                        "value_side": val_side,
                        "raw_json": json.dumps(data)
                    }

                elif resp.status_code == 429:
                    backoff = 3.0 * (attempt + 1)
                    logger.warning(f"Rate limited on {match_id}, backing off {backoff}s (attempt {attempt + 1}/5)")
                    await asyncio.sleep(backoff)

                elif resp.status_code == 404:
                    logger.debug(f"Match {match_id} not found (404)")
                    return None

                else:
                    logger.warning(f"Unexpected status {resp.status_code} for {match_id}")
                    await asyncio.sleep(1.0)

            except httpx.TimeoutException:
                logger.warning(f"Timeout fetching {match_id} (attempt {attempt + 1}/4)")
                await asyncio.sleep(1.5 * (attempt + 1))
            except httpx.HTTPError as e:
                logger.warning(f"HTTP error for {match_id}: {e} (attempt {attempt + 1}/4)")
                await asyncio.sleep(1.0 * (attempt + 1))
            except Exception as e:
                logger.error(f"Unexpected error for {match_id}: {e}", exc_info=True)
                await asyncio.sleep(1.0 * (attempt + 1))

    return None


def fetch_sitemap_urls() -> List[str]:
    resp = requests.get(SITEMAP_URL, headers=HEADERS, timeout=20)
    resp.raise_for_status()

    root = ET.fromstring(resp.content)
    namespaces = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = []
    for elem in root.findall(".//sm:loc", namespaces):
        if elem.text and elem.text.strip():
            locs.append(elem.text.strip())
    return locs


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
        scraper_live_state["total_urls"] = len(urls)
        scraper_live_state["phase"] = "scraping_matches"
        scraper_live_state["status_text"] = f"Scraping {len(urls)} matches from API..."
        logger.info(f"Found {len(urls)} match URLs in sitemap.")
    except Exception as e:
        logger.error(f"Failed to fetch sitemap: {e}")
        scraper_live_state.update({
            "is_running": False,
            "phase": "error",
            "status_text": f"Failed to fetch sitemap: {e}",
        })
        database.record_scraper_run({
            "timestamp": timestamp_iso,
            "total_urls": 0, "scraped_matches": 0, "new_matches": 0,
            "updated_matches": 0, "errors": 1,
            "duration_seconds": round(time.time() - start_time, 2),
            "status": f"Error: {e}"
        })
        return {"status": "error", "message": str(e)}

    semaphore = asyncio.Semaphore(3)
    results: List[Optional[Dict[str, Any]]] = []
    chunk_size = 15

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(16.0, connect=10.0),
        limits=httpx.Limits(max_connections=8, max_keepalive_connections=4)
    ) as client:
        for i in range(0, len(urls), chunk_size):
            chunk = urls[i:i + chunk_size]
            tasks = [fetch_match_data(client, semaphore, url) for url in chunk]
            chunk_results = await asyncio.gather(*tasks, return_exceptions=True)

            for r in chunk_results:
                if isinstance(r, Exception):
                    logger.error(f"Task exception: {r}")
                    results.append(None)
                else:
                    results.append(r)

            scraper_live_state["processed_count"] = len(results)
            scraper_live_state["status_text"] = f"Scraping matches ({len(results)}/{len(urls)})..."
            await asyncio.sleep(0.4)

    scraper_live_state["phase"] = "saving"
    scraper_live_state["status_text"] = "Saving match records to database..."

    new_count = 0
    updated_count = 0
    errors_count = 0

    for res in results:
        if res and isinstance(res, dict):
            try:
                is_new = database.upsert_match(res)
                if is_new:
                    new_count += 1
                else:
                    updated_count += 1
            except Exception as e:
                errors_count += 1
                logger.error(f"DB upsert error for {res.get('id', '?')}: {e}")
        else:
            errors_count += 1

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
    tennis_matches = database.get_matches(sport="tennis", sort_order="asc", limit=500)
    football_matches = database.get_matches(sport="football", sort_order="asc", limit=500)
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
            "tennis": tennis_matches,
            "football": football_matches
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
    import shutil
    shutil.copy2(out_file, root_file)


def scrape_sync():
    """Synchronous entry point. Safe to call from threads — creates its own event loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(run_scraper_pipeline())
    finally:
        loop.close()


if __name__ == "__main__":
    scrape_sync()
