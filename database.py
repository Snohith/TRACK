import sqlite3
import json
import os
from datetime import datetime
from typing import List, Dict, Any, Optional

DB_FILE = os.path.join(os.path.dirname(__file__), "matches.db")

def get_connection():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        url TEXT,
        sport TEXT NOT NULL,          -- 'tennis' or 'football'
        league TEXT,                  -- 'ATP Challenger', 'La Liga', etc.
        location TEXT,                -- 'Augsburg', etc.
        home_name TEXT NOT NULL,
        away_name TEXT NOT NULL,
        home_initials TEXT,
        away_initials TEXT,
        home_avatar TEXT,
        away_avatar TEXT,
        start_time TEXT NOT NULL,      -- ISO format string UTC
        start_timestamp INTEGER,      -- Unix timestamp for fast sorting
        
        -- Win Probabilities (percentage: 0-100)
        home_prob REAL,
        draw_prob REAL,
        away_prob REAL,
        
        -- Market Odds
        market_home REAL,
        market_draw REAL,
        market_away REAL,
        
        -- Fair (Model) Odds
        fair_home REAL,
        fair_draw REAL,
        fair_away REAL,
        
        -- Value Bet Indicator
        has_value INTEGER DEFAULT 0,
        value_side TEXT,              -- 'home', 'away', 'draw', or null
        
        raw_json TEXT,
        created_at TEXT,
        updated_at TEXT
    )
    """)

    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_sport_time ON matches (sport, start_timestamp ASC);
    """)
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_sport_league ON matches (sport, league);
    """)

    # Metadata table for scraper logs
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
    conn.close()

def upsert_match(match_data: Dict[str, Any]) -> bool:
    """Upsert a single match. Returns True if inserted as new, False if updated."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Check if exists
    cursor.execute("SELECT id FROM matches WHERE id = ?", (match_data["id"],))
    exists = cursor.fetchone() is not None
    now_iso = datetime.utcnow().isoformat() + "Z"

    cursor.execute("""
    INSERT INTO matches (
        id, url, sport, league, location,
        home_name, away_name, home_initials, away_initials,
        home_avatar, away_avatar, start_time, start_timestamp,
        home_prob, draw_prob, away_prob,
        market_home, market_draw, market_away,
        fair_home, fair_draw, fair_away,
        has_value, value_side,
        raw_json, created_at, updated_at
    ) VALUES (
        :id, :url, :sport, :league, :location,
        :home_name, :away_name, :home_initials, :away_initials,
        :home_avatar, :away_avatar, :start_time, :start_timestamp,
        :home_prob, :draw_prob, :away_prob,
        :market_home, :market_draw, :market_away,
        :fair_home, :fair_draw, :fair_away,
        :has_value, :value_side,
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
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    """, {
        **match_data,
        "created_at": now_iso if not exists else None,
        "updated_at": now_iso
    })

    conn.commit()
    conn.close()
    return not exists

def get_matches(
    sport: Optional[str] = None,
    search: Optional[str] = None,
    league: Optional[str] = None,
    value_only: bool = False,
    sort_order: str = "asc",
    limit: int = 300,
    offset: int = 0
) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()

    conditions = []
    params = []

    if sport:
        conditions.append("sport = ?")
        params.append(sport.lower())

    if league and league != "all":
        conditions.append("league LIKE ?")
        params.append(f"%{league}%")

    if value_only:
        conditions.append("has_value = 1")

    if search:
        search_term = f"%{search.strip()}%"
        conditions.append("(home_name LIKE ? OR away_name LIKE ? OR league LIKE ? OR location LIKE ?)")
        params.extend([search_term, search_term, search_term, search_term])

    where_clause = " WHERE " + " AND ".join(conditions) if conditions else ""
    direction = "ASC" if sort_order.lower() == "asc" else "DESC"
    
    query = f"""
    SELECT * FROM matches
    {where_clause}
    ORDER BY start_timestamp {direction}
    LIMIT ? OFFSET ?
    """
    params.extend([limit, offset])

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_leagues(sport: str) -> List[str]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT DISTINCT league FROM matches WHERE sport = ? AND league IS NOT NULL AND league != '' ORDER BY league ASC
    """, (sport.lower(),))
    rows = cursor.fetchall()
    conn.close()
    return [r[0] for r in rows if r[0]]

def get_stats() -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM matches WHERE sport = 'tennis'")
    tennis_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM matches WHERE sport = 'football'")
    football_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM matches WHERE has_value = 1")
    value_count = cursor.fetchone()[0]

    cursor.execute("SELECT * FROM scraper_runs ORDER BY id DESC LIMIT 1")
    last_run = cursor.fetchone()
    last_run_dict = dict(last_run) if last_run else None

    conn.close()
    return {
        "tennis_count": tennis_count,
        "football_count": football_count,
        "total_count": tennis_count + football_count,
        "value_count": value_count,
        "last_run": last_run_dict
    }

def record_scraper_run(run_data: Dict[str, Any]):
    conn = get_connection()
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
    conn.close()
