import asyncio
import re
import time
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
import httpx
import requests

import database

SITEMAP_URL = "https://www.statsarena.site/sitemap-matches.xml"
API_BASE_URL = "https://statsarena-v2-backend.onrender.com/api/v2/predictions/match"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.statsarena.site",
    "Referer": "https://www.statsarena.site/"
}

# Live status dictionary for real-time progress tracking
scraper_live_state = {
    "is_running": False,
    "status_text": "Idle",
    "phase": "idle", # 'idle', 'fetching_sitemap', 'scraping_matches', 'saving', 'finished', 'error'
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
    return scraper_live_state

def get_initials(name: str) -> str:
    """Generate 2-letter initials for players/teams."""
    if not name:
        return "??"
    parts = [p.strip() for p in name.replace(".", " ").replace("-", " ").split() if p.strip()]
    if len(parts) >= 2:
        return (parts[0][0] + parts[1][0]).upper()
    elif len(parts) == 1:
        return parts[0][:2].upper()
    return "??"

def clean_league_and_location(league_raw: str, sport: str):
    """Parse league string and extract tour name and location/city."""
    if not league_raw:
        return "Unknown League", ""

    league = league_raw.strip()
    location = ""

    if "—" in league:
        parts = league.split("—")
        league = parts[0].strip()
        location = parts[1].strip()
    elif " - " in league:
        parts = league.split(" - ")
        league = parts[0].strip()
        location = parts[1].strip()

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
    return parts[-1]

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
    except Exception:
        now = datetime.now(timezone.utc)
        return time_str, int(now.timestamp())

def determine_value_bet(home_prob: Optional[float], away_prob: Optional[float], draw_prob: Optional[float],
                        m_home: Optional[float], m_away: Optional[float], m_draw: Optional[float],
                        f_home: Optional[float], f_away: Optional[float], f_draw: Optional[float]) -> tuple[int, Optional[str]]:
    candidates = []
    if m_home and f_home and m_home > f_home * 1.03 and (home_prob or 0) >= 20:
        candidates.append(("home", (m_home / f_home) - 1.0))
    if m_away and f_away and m_away > f_away * 1.03 and (away_prob or 0) >= 20:
        candidates.append(("away", (m_away / f_away) - 1.0))
    if m_draw and f_draw and m_draw > f_draw * 1.03 and (draw_prob or 0) >= 20:
        candidates.append(("draw", (m_draw / f_draw) - 1.0))

    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        return 1, candidates[0][0]

    return 0, None

async def fetch_match_data(client: httpx.AsyncClient, semaphore: asyncio.Semaphore, url: str) -> Optional[Dict[str, Any]]:
    match_id = extract_match_id(url)
    sport = determine_sport(url, match_id)
    api_url = f"{API_BASE_URL}/{match_id}"

    async with semaphore:
        for attempt in range(4):
            try:
                resp = await client.get(api_url, headers=HEADERS, timeout=12.0)
                if resp.status_code == 200:
                    data = resp.json()
                    
                    league_raw = data.get("league", "")
                    league, location = clean_league_and_location(league_raw, sport)
                    
                    home_name = data.get("home_team", "Home")
                    away_name = data.get("away_team", "Away")
                    
                    avatars = data.get("contender_avatar") or {}
                    home_avatar = avatars.get("home", "")
                    away_avatar = avatars.get("away", "")

                    start_time_iso, start_timestamp = parse_iso_time(data.get("start_time"))

                    # Odds & Probabilities
                    market_odds = data.get("market_odds", {}).get("1x2", {})
                    market_dec = market_odds.get("decimal") or {}
                    m_home = market_dec.get("home")
                    m_draw = market_dec.get("draw")
                    m_away = market_dec.get("away")

                    model_odds = data.get("model_odds", {}).get("1x2", {})
                    model_dec = model_odds.get("decimal") or {}
                    f_home = model_dec.get("home")
                    f_draw = model_dec.get("draw")
                    f_away = model_dec.get("away")

                    model_probs = model_odds.get("probability_pct") or {}
                    h_prob = model_probs.get("home")
                    d_prob = model_probs.get("draw")
                    a_prob = model_probs.get("away")

                    if h_prob is None and a_prob is None:
                        m_probs = market_odds.get("probability_pct") or {}
                        h_prob = m_probs.get("home")
                        d_prob = m_probs.get("draw")
                        a_prob = m_probs.get("away")

                    has_val, val_side = determine_value_bet(
                        h_prob, a_prob, d_prob,
                        m_home, m_away, m_draw,
                        f_home, f_away, f_draw
                    )

                    await asyncio.sleep(0.08)
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
                        "home_prob": round(h_prob, 1) if h_prob is not None else None,
                        "draw_prob": round(d_prob, 1) if d_prob is not None else None,
                        "away_prob": round(a_prob, 1) if a_prob is not None else None,
                        "market_home": round(m_home, 2) if m_home is not None else None,
                        "market_draw": round(m_draw, 2) if m_draw is not None else None,
                        "market_away": round(m_away, 2) if m_away is not None else None,
                        "fair_home": round(f_home, 2) if f_home is not None else None,
                        "fair_draw": round(f_draw, 2) if f_draw is not None else None,
                        "fair_away": round(f_away, 2) if f_away is not None else None,
                        "has_value": has_val,
                        "value_side": val_side,
                        "raw_json": json.dumps(data)
                    }
                elif resp.status_code == 429:
                    backoff = 1.5 * (attempt + 1)
                    await asyncio.sleep(backoff)
                elif resp.status_code == 404:
                    return None
            except Exception:
                await asyncio.sleep(1.0 * (attempt + 1))
    return None

def fetch_sitemap_urls() -> List[str]:
    resp = requests.get(SITEMAP_URL, headers=HEADERS, timeout=15)
    resp.raise_for_status()

    root = ET.fromstring(resp.content)
    namespaces = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [elem.text.strip() for elem in root.findall(".//sm:loc", namespaces) if elem.text]
    return locs

async def run_scraper_pipeline() -> Dict[str, Any]:
    global scraper_live_state
    
    database.init_db()
    start_time = time.time()
    timestamp_iso = datetime.now(timezone.utc).isoformat()

    scraper_live_state["is_running"] = True
    scraper_live_state["phase"] = "fetching_sitemap"
    scraper_live_state["status_text"] = "Fetching sitemap XML..."
    scraper_live_state["start_time"] = timestamp_iso
    scraper_live_state["processed_count"] = 0
    scraper_live_state["new_count"] = 0
    scraper_live_state["updated_count"] = 0
    scraper_live_state["error_count"] = 0

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting StatsArena scraper...")

    try:
        urls = fetch_sitemap_urls()
        scraper_live_state["total_urls"] = len(urls)
        scraper_live_state["phase"] = "scraping_matches"
        scraper_live_state["status_text"] = f"Scraping {len(urls)} matches from API..."
    except Exception as e:
        scraper_live_state["is_running"] = False
        scraper_live_state["phase"] = "error"
        scraper_live_state["status_text"] = f"Failed to fetch sitemap: {e}"
        database.record_scraper_run({
            "timestamp": timestamp_iso,
            "total_urls": 0,
            "scraped_matches": 0,
            "new_matches": 0,
            "updated_matches": 0,
            "errors": 1,
            "duration_seconds": round(time.time() - start_time, 2),
            "status": f"Error: {e}"
        })
        return {"status": "error", "message": str(e)}

    semaphore = asyncio.Semaphore(4)
    results = []
    chunk_size = 20

    async with httpx.AsyncClient(timeout=15.0) as client:
        for i in range(0, len(urls), chunk_size):
            chunk = urls[i:i + chunk_size]
            tasks = [fetch_match_data(client, semaphore, url) for url in chunk]
            chunk_results = await asyncio.gather(*tasks)
            results.extend(chunk_results)
            
            scraper_live_state["processed_count"] = len(results)
            scraper_live_state["status_text"] = f"Scraping matches ({len(results)}/{len(urls)})..."
            await asyncio.sleep(0.25)

    scraper_live_state["phase"] = "saving"
    scraper_live_state["status_text"] = "Saving match records to database..."

    new_count = 0
    updated_count = 0
    errors_count = 0

    for res in results:
        if res:
            try:
                is_new = database.upsert_match(res)
                if is_new:
                    new_count += 1
                else:
                    updated_count += 1
            except Exception as e:
                errors_count += 1
        else:
            errors_count += 1

    duration = round(time.time() - start_time, 2)
    status_msg = f"Finished: {len(results) - errors_count} matches updated ({new_count} new, {updated_count} refreshed) in {duration}s"
    
    database.record_scraper_run({
        "timestamp": timestamp_iso,
        "total_urls": len(urls),
        "scraped_matches": len(results) - errors_count,
        "new_matches": new_count,
        "updated_matches": updated_count,
        "errors": errors_count,
        "duration_seconds": duration,
        "status": status_msg
    })

    # Also export static data.json for GitHub hosting
    try:
        export_static_json()
    except Exception as e:
        print(f"Static JSON export warning: {e}")

    scraper_live_state["is_running"] = False
    scraper_live_state["phase"] = "finished"
    scraper_live_state["status_text"] = status_msg
    scraper_live_state["new_count"] = new_count
    scraper_live_state["updated_count"] = updated_count
    scraper_live_state["error_count"] = errors_count
    scraper_live_state["duration_seconds"] = duration
    scraper_live_state["last_finished_time"] = datetime.now(timezone.utc).isoformat()

    print(f"Scraper completed. {status_msg}")
    return {
        "status": "success",
        "total_urls": len(urls),
        "scraped_matches": len(results) - errors_count,
        "new_matches": new_count,
        "updated_matches": updated_count,
        "errors": errors_count,
        "duration_seconds": duration
    }

def export_static_json():
    """Export complete dataset to static/data.json for GitHub Pages / static hosting."""
    import os
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

    out_file = os.path.join(os.path.dirname(__file__), "static", "data.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

def scrape_sync():
    return asyncio.run(run_scraper_pipeline())

if __name__ == "__main__":
    scrape_sync()
