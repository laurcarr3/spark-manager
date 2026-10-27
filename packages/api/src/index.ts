import { createApp } from "./app.js";

const port = Number(process.env.SPARK_MANAGER_API_PORT ?? 3000);
const app = createApp({ token: process.env.SPARK_MANAGER_API_TOKEN });

app.listen(port, "127.0.0.1", () => {
  console.log(`spark-manager API listening on http://127.0.0.1:${port}`);
});
