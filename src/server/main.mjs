import { createCallWindowServer } from "./app.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4174);
const server = createCallWindowServer();

server.listen(port, host, () => {
  console.log(`CallWindow server listening on http://${host}:${port}`);
});
