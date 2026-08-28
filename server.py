import os
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import database
import scheduler

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

# API Endpoints
@app.get("/api/matches")
async def get_matches(
    sport: Optional[str] = Query(None, description="tennis or football"),
    search: Optional[str] = Query(None, description="Search term for player/team/tournament"),
    league: Optional[str] = Query(None, description="Filter by league/tour"),
    value_only: bool = Query(False, description="Filter only value bets"),
    sort_order: str = Query("asc", description="asc or desc"),
    limit: int = Query(500, description="Max number of matches to return"),
    offset: int = Query(0, description="Pagination offset")
):
    matches = database.get_matches(
        sport=sport,
        search=search,
        league=league,
        value_only=value_only,
        sort_order=sort_order,
        limit=limit,
        offset=offset
    )
    return {"matches": matches, "count": len(matches)}

@app.get("/api/leagues")
async def get_leagues(sport: str = Query(..., description="tennis or football")):
    leagues = database.get_leagues(sport)
    return {"leagues": leagues}

@app.get("/api/status")
async def get_status():
    return scheduler.get_scheduler_status()

@app.post("/api/scrape/trigger")
async def trigger_scrape():
    res = scheduler.trigger_manual_scrape()
    return res

# Static file direct routes for maximum compatibility
static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)

@app.get("/style.css")
async def get_style():
    return FileResponse(os.path.join(static_dir, "style.css"), media_type="text/css")

@app.get("/app.js")
async def get_app_js():
    return FileResponse(os.path.join(static_dir, "app.js"), media_type="application/javascript")

@app.get("/data.json")
async def get_data_json():
    data_file = os.path.join(static_dir, "data.json")
    if os.path.exists(data_file):
        return FileResponse(data_file, media_type="application/json")
    return JSONResponse(content={"error": "Not exported yet"}, status_code=404)

# Mount /static prefix
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(static_dir, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=False)
