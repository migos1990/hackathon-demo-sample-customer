/**
 * /admin — read-only HTML user list for AcmeHR-lite.
 *
 * Drives the demo's shot 5 ("users land in AcmeHR") payoff. Meta-refresh
 * every 2 seconds so newly-provisioned users appear without the operator
 * touching the page — visible provisioning is the whole point.
 *
 * Admin page is auth-EXEMPT by design (see admin.test.ts last case for
 * rationale). Mount this router BEFORE the auth middleware in server.ts.
 *
 * Inline CSS + HTML — no template engine, no build step. One file, one
 * response. The shot needs the page to look legit on video; it does not
 * need a framework.
 */
import { Router, type Request, type Response } from "express";
import type { InMemoryAcmeHrStore } from "../store.js";
import type { AcmeHrUser } from "../types.js";

export function adminRouter(store: InMemoryAcmeHrStore): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const users = store.list();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderAdminPage(users));
  });

  return router;
}

function renderAdminPage(users: AcmeHrUser[]): string {
  const rows = users.length === 0
    ? `<tr><td colspan="6" class="empty">No users yet. Waiting for provisioning…</td></tr>`
    : users.map(userRow).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<title>AcmeHR — Admin</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #1a202c; }
  header { background: #1f2937; color: white; padding: 16px 24px; border-bottom: 3px solid #3b82f6; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .sub { margin-top: 2px; font-size: 12px; color: #9ca3af; }
  main { padding: 24px; }
  .count { font-size: 14px; color: #4b5563; margin-bottom: 12px; }
  table { width: 100%; background: white; border-collapse: collapse; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-radius: 4px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; background: #f9fafb; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 10px 12px; font-size: 14px; border-bottom: 1px solid #f3f4f6; }
  tr:last-child td { border-bottom: none; }
  tr[data-enabled="false"] { opacity: 0.45; }
  tr[data-enabled="false"] td.status { color: #b91c1c; font-weight: 500; }
  tr[data-enabled="true"] td.status { color: #047857; font-weight: 500; }
  .empty { text-align: center; color: #9ca3af; padding: 24px; font-style: italic; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 13px; color: #2563eb; }
  footer { padding: 16px 24px; font-size: 12px; color: #9ca3af; }
</style>
</head>
<body>
<header>
  <h1>AcmeHR — Admin</h1>
  <div class="sub">Customer HRIS · us-east-1 · auto-refresh 2s</div>
</header>
<main>
  <div class="count">${users.length} user${users.length === 1 ? "" : "s"}</div>
  <table>
    <thead>
      <tr>
        <th>UID</th>
        <th>Name</th>
        <th>Email</th>
        <th>Title</th>
        <th>Status</th>
        <th>Last Modified</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</main>
<footer>AcmeHR-lite · demo target · <code>demo-targets/acme-hr-lite/</code></footer>
</body>
</html>`;
}

function userRow(u: AcmeHrUser): string {
  const status = u.enabled ? "Active" : "Deactivated";
  return `      <tr data-enabled="${u.enabled}">
        <td><code>${escapeHtml(u.uid)}</code></td>
        <td>${escapeHtml(u.cn)}</td>
        <td>${escapeHtml(u.mail)}</td>
        <td>${escapeHtml(u.title ?? "—")}</td>
        <td class="status">${status}</td>
        <td>${escapeHtml(u.lastModified)}</td>
      </tr>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
