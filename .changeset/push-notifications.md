---
'mcdashboard-proxy': minor
---

Push notifications (plugin 1.1.0, licensed servers): the proxy routes a device's own `GET`, `PUT` and `DELETE /v1/devices/self/push` (never cached) and reports the `push` feature, so apps behind the proxy can switch push on. CORS allows `PUT`.
