import express from "express";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = express();

app.get("/health", (_request, response) => {
  response.json({ service: "spark-manager", status: "ok" });
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`spark-manager API listening on http://127.0.0.1:${port}`);
});
