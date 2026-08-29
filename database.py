import sqlite3
import json
import os
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "matches.db")

def get_connection():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def init_db():
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            id TEXT PRIMARY KEY,
            url TEXT,
            sport TEXT NOT NULL,
            league TEXT,
            location TEXT,
            home_name TEXT NOT NULL,
            away_name TEXT NOT NULL,
            home_initials TEXT,
            away_initials TEXT,
            home_avatar TEXT,
            away_avatar TEXT,
            start_time TEXT NOT NULL,
            start_timestamp INTEGER NOT NULL DEFAULT 0,
            home_prob REAL,
            draw_prob REAL,
            away_prob REAL,
            market_home REAL,
            market_draw REAL,
            market_away REAL,
            fair_home REAL,
            fair_draw REAL,
            fair_away REAL,
            has_value INTEGER DEFAULT 0,
            value_side TEXT,
            value_edge REAL DEFAULT 0.0,
            fav_side TEXT,
            fav_prob REAL DEFAULT 0.0,
            fav_odds REAL DEFAULT 0.0,
            fav_ev REAL DEFAULT 0.0,
            in_sitemap INTEGER DEFAULT 1,
            is_finished INTEGER DEFAULT 0,
            finished_at TEXT,
            raw_json TEXT,
            created_at TEXT,
            updated_at TEXT
        )
        """)

        # Add missing columns dynamically if upgrading
        columns_to_add = [
            ("value_edge", "REAL DEFAULT 0.0"),
            ("fav_side", "TEXT"),
            ("fav_prob", "REAL DEFAULT 0.0"),
            ("fav_odds", "REAL DEFAULT 0.0"),
            ("fav_ev", "REAL DEFAULT 0.0"),
            ("in_sitemap", "INTEGER DEFAULT 1"),
            ("is_finished", "INTEGER DEFAULT 0"),
            ("finished_at", "TEXT")
        ]
        for col_name, col_def in columns_to_add:
            try:
                cursor.execute(f"ALTER TABLE matches ADD COLUMN {col_name} {col_def}")
            except Exception:
                pass

        cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_sport_time ON matches (sport, start_timestamp ASC);
        """)
        cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_sport_league ON matches (sport, league);
        """)
        cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_finished ON matches (is_finished, in_sitemap);
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS scraper_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            total_urls INTEGER,
            scraped_matches INTEGER,
            new_matches INTEGER,
            updated_matches INTEGER,
            errors INTEGER,
            duration_seconds REAL,
            status TEXT
        )
        """)

        conn.commit()

def upsert_match(match_data: Dict[str, Any]) -> bool:
    """Upsert a single match. Returns True if inserted as new, False if updated."""
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        cursor = conn.cursor()
        
        cursor.execute("SELECT id FROM matches WHERE id = ?", (match_data["id"],))
        exists = cursor.fetchone() is not None

        # Calculate favorite metadata
        hp = float(match_data.get("home_prob") or 0.0)
        ap = float(match_data.get("away_prob") or 0.0)
        dp = float(match_data.get("draw_prob") or 0.0)
        mh = float(match_data.get("market_home") or 0.0)
        ma = float(match_data.get("market_away") or 0.0)
        md = float(match_data.get("market_draw") or 0.0)
        sport = match_data.get("sport", "tennis")

        fav_side, fav_prob, fav_odds = None, 0.0, 0.0
        if sport == "tennis" or not dp:
            if hp >= ap and hp > 0:
                fav_side, fav_prob, fav_odds = "home", hp, mh
            elif ap > hp:
                fav_side, fav_prob, fav_odds = "away", ap, ma
        else:
            max_p = max(hp, dp, ap)
            if max_p > 0:
                if max_p == hp:
                    fav_side, fav_prob, fav_odds = "home", hp, mh
                elif max_p == ap:
                    fav_side, fav_prob, fav_odds = "away", ap, ma
                else:
                    fav_side, fav_prob, fav_odds = "draw", dp, md

        fav_ev = round(((fav_prob / 100.0) * fav_odds - 1.0) * 100.0, 1) if (fav_prob > 0 and fav_odds > 1.0) else 0.0

        match_data_copy = {
            "id": match_data["id"],
            "url": match_data.get("url", ""),
            "sport": sport,
            "league": match_data.get("league", ""),
            "location": match_data.get("location", ""),
            "home_name": match_data.get("home_name", "Home"),
            "away_name": match_data.get("away_name", "Away"),
            "home_initials": match_data.get("home_initials", "H"),
            "away_initials": match_data.get("away_initials", "A"),
            "home_avatar": match_data.get("home_avatar", ""),
            "away_avatar": match_data.get("away_avatar", ""),
            "start_time": match_data.get("start_time", ""),
            "start_timestamp": match_data.get("start_timestamp", 0),
            "home_prob": match_data.get("home_prob"),
            "draw_prob": match_data.get("draw_prob"),
            "away_prob": match_data.get("away_prob"),
            "market_home": match_data.get("market_home"),
            "market_draw": match_data.get("market_draw"),
            "market_away": match_data.get("market_away"),
            "fair_home": match_data.get("fair_home"),
            "fair_draw": match_data.get("fair_draw"),
            "fair_away": match_data.get("fair_away"),
            "has_value": match_data.get("has_value", 0),
            "value_side": match_data.get("value_side"),
            "value_edge": match_data.get("value_edge", 0.0),
            "fav_side": fav_side,
            "fav_prob": fav_prob,
            "fav_odds": fav_odds,
            "fav_ev": fav_ev,
            "in_sitemap": match_data.get("in_sitemap", 1),
            "is_finished": match_data.get("is_finished", 0),
            "finished_at": match_data.get("finished_at"),
            "raw_json": match_data.get("raw_json", "{}"),
            "created_at": None if exists else now_iso,
            "updated_at": now_iso
        }

        cursor.execute("""
        INSERT INTO matches (
            id, url, sport, league, location,
            home_name, away_name, home_initials, away_initials,
            home_avatar, away_avatar, start_time, start_timestamp,
            home_prob, draw_prob, away_prob,
            market_home, market_draw, market_away,
            fair_home, fair_draw, fair_away,
            has_value, value_side, value_edge,
            fav_side, fav_prob, fav_odds, fav_ev,
            in_sitemap, is_finished, finished_at,
            raw_json, created_at, updated_at
        ) VALUES (
            :id, :url, :sport, :league, :location,
            :home_name, :away_name, :home_initials, :away_initials,
            :home_avatar, :away_avatar, :start_time, :start_timestamp,
            :home_prob, :draw_prob, :away_prob,
            :market_home, :market_draw, :market_away,
            :fair_home, :fair_draw, :fair_away,
            :has_value, :value_side, :value_edge,
            :fav_side, :fav_prob, :fav_odds, :fav_ev,
            :in_sitemap, :is_finished, :finished_at,
            :raw_json, :created_at, :updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            url = excluded.url,
            sport = excluded.sport,
            league = excluded.league,
            location = excluded.location,
            home_name = excluded.home_name,
            away_name = excluded.away_name,
            home_initials = excluded.home_initials,
            away_initials = excluded.away_initials,
            home_avatar = excluded.home_avatar,
            away_avatar = excluded.away_avatar,
            start_time = excluded.start_time,
            start_timestamp = excluded.start_timestamp,
            home_prob = excluded.home_prob,
            draw_prob = excluded.draw_prob,
            away_prob = excluded.away_prob,
            market_home = excluded.market_home,
            market_draw = excluded.market_draw,
            market_away = excluded.market_away,
            fair_home = excluded.fair_home,
            fair_draw = excluded.fair_draw,
            fair_away = excluded.fair_away,
            has_value = excluded.has_value,
            value_side = excluded.value_side,
            value_edge = excluded.value_edge,
            fav_side = excluded.fav_side,
            fav_prob = excluded.fav_prob,
            fav_odds = excluded.fav_odds,
            fav_ev = excluded.fav_ev,
            in_sitemap = excluded.in_sitemap,
            is_finished = excluded.is_finished,
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
        """, match_data_copy)

        conn.commit()
        return not exists

def purge_legacy_finished_matches(active_sitemap_ids: set) -> int:
    """Purges old completed matches that were already absent from the sitemap before this tracking reset."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM matches")
        all_ids = [r[0] for r in cursor.fetchall()]
        to_delete = [mid for mid in all_ids if mid not in active_sitemap_ids]
        if to_delete:
            cursor.executemany("DELETE FROM matches WHERE id = ?", [(mid,) for mid in to_delete])
            conn.commit()
        return len(to_delete)

def sync_finished_matches(active_sitemap_ids: set) -> int:
    """Marks matches that have dropped from the sitemap as finished."""
    now_iso = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM matches WHERE in_sitemap = 1")
        tracked_ids = [r[0] for r in cursor.fetchall()]
        
        finished_ids = [mid for mid in tracked_ids if mid not in active_sitemap_ids]
        for mid in finished_ids:
            cursor.execute("""
            UPDATE matches 
            SET in_sitemap = 0, is_finished = 1, finished_at = COALESCE(finished_at, ?) 
            WHERE id = ?
            """, (now_iso, mid))
        conn.commit()
        return len(finished_ids)

def get_matches(
    sport: Optional[str] = None,
    search: Optional[str] = None,
    league: Optional[str] = None,
    value_only: bool = False,
    fav_51_only: bool = False,
    is_finished: int = 0,
    sort_order: str = "asc",
    limit: int = 500,
    offset: int = 0
) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        cursor = conn.cursor()

        conditions = ["is_finished = ?"]
        params: list = [is_finished]

        if sport:
            conditions.append("sport = ?")
            params.append(sport.lower())

        if league and league != "all":
            conditions.append("league LIKE ?")
            params.append(f"%{league}%")

        if value_only:
            conditions.append("has_value = 1")

        if fav_51_only:
            conditions.append("fav_prob >= 51.0")

        if search:
            search_term = f"%{search.strip()}%"
            conditions.append("(home_name LIKE ? OR away_name LIKE ? OR league LIKE ? OR location LIKE ?)")
            params.extend([search_term, search_term, search_term, search_term])

        where_clause = " WHERE " + " AND ".join(conditions)
        direction = "ASC" if sort_order.lower() == "asc" else "DESC"
        
        query = f"""
        SELECT id, url, sport, league, location,
               home_name, away_name, home_initials, away_initials,
               home_avatar, away_avatar, start_time, start_timestamp,
               home_prob, draw_prob, away_prob,
               market_home, market_draw, market_away,
               fair_home, fair_draw, fair_away,
               has_value, value_side, value_edge,
               fav_side, fav_prob, fav_odds, fav_ev,
               in_sitemap, is_finished, finished_at,
               created_at, updated_at
        FROM matches
        {where_clause}
        ORDER BY start_timestamp {direction}
        LIMIT ? OFFSET ?
        """
        params.extend([limit, offset])

        cursor.execute(query, params)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

def get_leagues(sport: str) -> List[str]:
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT DISTINCT league FROM matches WHERE sport = ? AND league IS NOT NULL AND league != '' ORDER BY league ASC
        """, (sport.lower(),))
        rows = cursor.fetchall()
        return [r[0] for r in rows if r[0]]

def get_stats() -> Dict[str, Any]:
    with get_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) FROM matches WHERE sport = 'tennis' AND is_finished = 0")
        tennis_active = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM matches WHERE sport = 'football' AND is_finished = 0")
        football_active = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM matches WHERE has_value = 1 AND is_finished = 0")
        value_active = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM matches WHERE fav_prob >= 51.0 AND is_finished = 0")
        fav_51_active = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM matches WHERE is_finished = 1")
        finished_total = cursor.fetchone()[0]

        cursor.execute("SELECT * FROM scraper_runs ORDER BY id DESC LIMIT 10")
        runs = cursor.fetchall()
        history = [dict(r) for r in runs]
        last_run_dict = history[0] if history else None

        return {
            "tennis_count": tennis_active,
            "football_count": football_active,
            "total_count": tennis_active + football_active,
            "value_count": value_active,
            "fav_51_count": fav_51_active,
            "finished_count": finished_total,
            "last_run": last_run_dict,
            "history": history
        }

def record_scraper_run(run_data: Dict[str, Any]):
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        INSERT INTO scraper_runs (
            timestamp, total_urls, scraped_matches, new_matches,
            updated_matches, errors, duration_seconds, status
        ) VALUES (
            :timestamp, :total_urls, :scraped_matches, :new_matches,
            :updated_matches, :errors, :duration_seconds, :status
        )
        """, run_data)
        conn.commit()
