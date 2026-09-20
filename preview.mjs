// Isolated UI fixture server. Never connects to trading services or production storage.
import express from "express";
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const monday = new Date();
monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
const weekOf = monday.toISOString().slice(0, 10);
let walls = [1, 2].map((id) => ({
  id, symbol: "QQQ", weekOf, wallPrice: 720 + id * 5, referenceClose: 710,
  activeBranch: id === 1 ? "pending" : "rejects", gapPercent: null, reKeyed: false,
  notes: `DEMO ONLY: candidate ${id}`, createdAt: new Date().toISOString(),
}));
app.get("/api/campaign", (_req, res) => res.json(walls));
app.post("/api/campaign/resolve-duplicates", (req, res) => {
  walls = walls.filter((w) => w.id === req.body.keepId);
  res.json({ keepId: req.body.keepId, removed: 1 });
});
app.get("/api/flies", (_req, res) => res.json([]));
app.get("/api/gexbot/status", (_req, res) => res.json({ configured: false }));
app.get("/api/checklist/:week", (_req, res) => res.json(null));
app.use("/api", (_req, res) => res.status(503).json({ message: "Isolated demo: live services disabled" }));
app.use(express.static("dist/public"));
app.listen(5000, "0.0.0.0");
