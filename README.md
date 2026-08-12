# Image Vectorizer Prototype

Upload a raster image, vectorize it with [Vtracer](https://github.com/visioncortex/vtracer), and manage the resulting SVG paths as layers (hide/unhide, delete) in a right-hand sidebar.

## Run it

**Backend** (FastAPI + vtracer):

```bash
cd backend
py -m venv venv
./venv/Scripts/pip install -r requirements.txt
./venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

**Frontend** (Vite + React):

```bash
cd frontend
npm install
npm run dev
```

Open the printed local URL (default `http://localhost:5173`). The Vite dev server proxies `/api` requests to the backend on port 8000.
