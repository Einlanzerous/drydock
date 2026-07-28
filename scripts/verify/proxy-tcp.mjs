// TCP partition proxy for POSTGRES (DRY-58 verification).
//
// CLAUDE.md is explicit that `docker stop` is not an outage test: it frees the
// port, so every connect fails instantly with ECONNREFUSED and any latency bug
// hides. A real partition is host-up, packets-dropped — the connect ACKs and
// then nothing ever comes back, which is what costs the pool its full
// `connectionTimeoutMillis` per attempt. That distinction concealed a live bug
// once already (DRY-28's cooldown keyed off "have we migrated yet").
//
// Partitioned here means: accept the TCP connection, forward nothing, close
// nothing. Existing connections are frozen too, not reset — resetting them
// would be another instant failure.
//
// Control: POST /__break, POST /__heal, GET /__state on CONTROL_PORT.
import http from "node:http";
import net from "node:net";

const LISTEN = Number(process.env.PG_PROXY_PORT ?? 5456);
const TARGET = Number(process.env.PG_PORT ?? 5455);
const CONTROL = Number(process.env.CONTROL_PORT ?? 5457);

let partitioned = false;
const parked = new Set(); // connections accepted while partitioned, never served
const live = new Set(); // established pairs, frozen on break

net
  .createServer((client) => {
    if (partitioned) {
      // Accepted, and that is all it will ever get.
      parked.add(client);
      client.on("close", () => parked.delete(client));
      client.on("error", () => {});
      return;
    }
    const up = net.connect(TARGET, "127.0.0.1");
    const pair = { client, up };
    live.add(pair);
    const drop = () => {
      live.delete(pair);
      client.destroy();
      up.destroy();
    };
    up.on("error", drop);
    client.on("error", drop);
    up.on("close", drop);
    client.on("close", drop);
    client.pipe(up).pipe(client);
  })
  .listen(LISTEN, "127.0.0.1", () =>
    console.log(`[proxy-tcp] :${LISTEN} → :${TARGET}  (control :${CONTROL})`),
  );

http
  .createServer((req, res) => {
    const p = (req.url ?? "").split("?")[0];
    if (p === "/__break") {
      partitioned = true;
      // The pool keeps idle connections (idleTimeoutMillis 30s), so blocking
      // only NEW ones lets an established socket sail straight through and the
      // partition never happens. Freeze the live pairs instead of closing them
      // — closing is a reset, which is the instant failure this test exists to
      // avoid reproducing.
      for (const { client, up } of live) {
        client.unpipe(up);
        up.unpipe(client);
        client.pause();
        up.pause();
      }
    }
    if (p === "/__heal") {
      partitioned = false;
      for (const s of parked) s.destroy();
      parked.clear();
      // Frozen sockets are unresumable in practice: the client gave up mid
      // protocol, so the pg session behind them is in an unknown state. Drop
      // them and let the pool redial — which is also the DRY-45 path, since an
      // idle client dying is what makes the Pool emit 'error'.
      for (const pair of [...live]) {
        live.delete(pair);
        pair.client.destroy();
        pair.up.destroy();
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ partitioned, parked: parked.size, live: live.size }));
  })
  .listen(CONTROL, "127.0.0.1");
