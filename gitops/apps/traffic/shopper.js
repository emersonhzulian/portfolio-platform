// Synthetic shopper (k6): background traffic that behaves like a visitor, through the public
// URL - Cloudflare, the tunnel and the gateway - so it is split like real traffic during a
// canary and the dashboards and the canary analysis always have requests to look at.
//
//   browse - the catalog, once a second (web -> orders);
//   buy    - every few minutes, as the bot account `synthetic-shopper`: a real OIDC login
//            against authentik when its session has expired, then a purchase through the
//            page's own form - payment, webhook, Kafka, receipt.
// This is not a load test: no thresholds, a constant trickle.
import http from "k6/http";
import { check } from "k6";
import { parseHTML } from "k6/html";

const SHOP = "https://shop.emersonzulian.dev";
const AUTH = "https://auth.emersonzulian.dev";
const USER = __ENV.SHOPPER_USERNAME;
const PASSWORD = __ENV.SHOPPER_PASSWORD;
const HEADERS = { "User-Agent": "portfolio-synthetic-shopper (k6)" };

export const options = {
  scenarios: {
    browse: {
      executor: "constant-arrival-rate", exec: "browse",
      rate: 1, timeUnit: "1s", duration: "8760h", preAllocatedVUs: 2, maxVUs: 4,
    },
    buy: {
      executor: "constant-arrival-rate", exec: "buy",
      rate: 1, timeUnit: "3m", duration: "8760h", preAllocatedVUs: 1, maxVUs: 1,
    },
  },
  // Keep the per-URL label cardinality bounded (order ids would make a series per order).
  tags: { app: "shop" },
};

export function browse() {
  const res = http.get(`${SHOP}/`, { headers: HEADERS, tags: { name: "catalog" } });
  check(res, { "catalog 200": (r) => r.status === 200 });
}

// authentik's flow executor, the same API its login page uses.
function login() {
  const start = http.get(`${SHOP}/auth/login?returnTo=/`, { headers: HEADERS, tags: { name: "login" } });
  const [path, query] = start.url.split("?");
  const slug = path.split("/if/flow/")[1].replace(/\/$/, "");
  const executor = `${AUTH}/api/v3/flows/executor/${slug}/?query=${encodeURIComponent(query)}`;
  const json = { headers: { ...HEADERS, "Content-Type": "application/json" }, tags: { name: "login" } };
  http.get(executor, json);
  http.post(executor, JSON.stringify({ component: "ak-stage-identification", uid_field: USER }), json);
  const done = http.post(executor, JSON.stringify({ component: "ak-stage-password", password: PASSWORD }), json).json();
  // authorize -> shop callback (sets the session cookie) -> catalog
  return http.get(`${AUTH}${done.to}`, { headers: HEADERS, tags: { name: "login" } });
}

export function buy() {
  let page = http.get(`${SHOP}/`, { headers: HEADERS, tags: { name: "catalog" } });
  if (!page.body.includes(USER)) page = login();

  // The product forms are Next.js server actions; posted as a plain HTML form, no JavaScript.
  const productId = String(1 + Math.floor(Math.random() * 6));
  const doc = parseHTML(page.body);
  const fields = { quantity: "1" };
  doc.find(`form:has(input[name="productId"][value="${productId}"]) input[type="hidden"]`).each((_, el) => {
    fields[el.getAttribute("name")] = el.getAttribute("value") || "";
  });
  const boundary = `----k6${Date.now()}`;
  const body = Object.entries(fields)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;
  const res = http.post(`${SHOP}/`, body, {
    headers: { ...HEADERS, "Content-Type": `multipart/form-data; boundary=${boundary}`, Origin: SHOP },
    tags: { name: "checkout" },
  });
  check(res, { "order placed": (r) => r.url.includes("/orders/") });
}

// Smoke run by hand: `k6 run --iterations 1 shopper.js` (the CLI flag replaces the scenarios).
export default function () {
  browse();
  buy();
}
