import { createWriteStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

export type OrderPaid = {
  orderId: string;
  userName: string;
  total: number;
  paidAt: string;
  items: { productName: string; unitPrice: number; quantity: number }[];
};

// Same rule FileBrowser applies to a user's home folder (users/<name>, see its cleanUsername):
// the receipt has to land in the folder that user will see.
export function homeFolder(userName: string): string {
  const cleaned = userName.trim().replaceAll("..", "").replace(/[^0-9A-Za-z@_\-.]/g, "-").replace(/-+/g, "-");
  return path.join("users", cleaned || "unknown");
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

// Writes <root>/users/<user>/receipt-<order>.pdf. Idempotent: delivery is at-least-once, so an
// event seen twice finds its receipt already there and changes nothing.
export async function writeReceipt(root: string, order: OrderPaid): Promise<{ file: string; created: boolean }> {
  const dir = path.join(root, homeFolder(order.userName));
  const file = path.join(dir, `receipt-${order.orderId}.pdf`);
  try {
    await access(file);
    return { file, created: false };
  } catch { /* not there yet */ }

  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 40, info: { Title: `Receipt ${order.orderId}` } });
    const out = createWriteStream(tmp);
    out.on("finish", resolve).on("error", reject);
    doc.pipe(out);
    doc.fontSize(18).text("Portfolio Shop").moveDown(0.3);
    doc.fontSize(9).fillColor("#666").text("Demo receipt - no money was moved (simulated Pix).").moveDown();
    doc.fillColor("#000").fontSize(10)
      .text(`Order: ${order.orderId}`)
      .text(`Customer: ${order.userName}`)
      .text(`Paid at: ${new Date(order.paidAt).toISOString().replace("T", " ").slice(0, 19)} UTC`)
      .moveDown();
    for (const item of order.items) {
      doc.text(`${item.quantity} x ${item.productName}`, { continued: true })
        .text(brl.format(item.unitPrice * item.quantity), { align: "right" });
    }
    doc.moveDown().fontSize(12).text(`Total: ${brl.format(order.total)}`, { align: "right" });
    doc.end();
  });
  await rename(tmp, file); // never a half-written receipt in the user's folder
  return { file, created: true };
}
