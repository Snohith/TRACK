import os
import logging
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import database
import scheduler

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(static_dir, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    scheduler.start_scheduler()
    yield

app = FastAPI(title="StatsArena Match Tracker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── API Routes (registered BEFORE static mount) ───

@app.get("/api/matches")
async def get_matches(
    sport: Optional[str] = Query(None, description="tennis or football"),
    search: Optional[str] = Query(None, description="Search term"),
    league: Optional[str] = Query(None, description="Filter by league"),
    value_only: bool = Query(False, description="Filter value bets only"),
    fav_51_only: bool = Query(False, description="Filter favorites with >=51% probability"),
    is_finished: int = Query(0, description="0 for active, 1 for finished"),
    sort_order: str = Query("asc", description="asc or desc"),
    limit: int = Query(500, ge=1, le=1000, description="Max results"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
):
    matches = database.get_matches(
        sport=sport, search=search, league=league,
        value_only=value_only, fav_51_only=fav_51_only,
        is_finished=is_finished, sort_order=sort_order,
        limit=limit, offset=offset,
    )
    return {"matches": matches, "count": len(matches)}

@app.get("/api/leagues")
async def get_leagues(sport: str = Query(..., description="tennis or football")):
    leagues = database.get_leagues(sport)
    return {"leagues": leagues}

@app.get("/api/status")
async def get_status():
    return scheduler.get_scheduler_status()

@app.get("/api/health")
async def health_check():
    from datetime import datetime, timezone
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}

@app.post("/api/scrape/trigger")
async def trigger_scrape():
    return scheduler.trigger_manual_scrape()


# ─── Static File Routes (explicit for root-relative paths in HTML) ───

@app.get("/style.css")
async def serve_css():
    path = os.path.join(static_dir, "style.css")
    if os.path.isfile(path):
        return FileResponse(path, media_type="text/css")
    return JSONResponse({"error": "Not found"}, status_code=404)

@app.get("/app.js")
async def serve_js():
    path = os.path.join(static_dir, "app.js")
    if os.path.isfile(path):
        return FileResponse(path, media_type="application/javascript")
    return JSONResponse({"error": "Not found"}, status_code=404)

@app.get("/data.json")
async def serve_data_json():
    path = os.path.join(static_dir, "data.json")
    if os.path.isfile(path):
        return FileResponse(path, media_type="application/json")
    return JSONResponse({"error": "Not exported yet"}, status_code=404)

@app.get("/favicon.ico")
async def serve_favicon():
    return JSONResponse(content={}, status_code=204)

# ─── Index Page ───

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(static_dir, "index.html"), media_type="text/html")

# ─── Static mount for /static/* prefix (MUST be last — catches everything) ───

app.mount("/static", StaticFiles(directory=static_dir), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=False)
