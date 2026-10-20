# Open work

- Pass the Aux side (in the pass-the-aux repo): call `GET /api/status` from a "test connection"
  button in Settings → Remote record stores, show `data.library.scanning` as "still indexing"
  in search, and unwrap `fetch failed` into the real cause (connection refused, unknown host).
