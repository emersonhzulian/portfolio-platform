import type { NextConfig } from "next";

const config: NextConfig = {
  // A self-contained server.js plus only the node_modules it needs: small image, no npm at runtime.
  output: "standalone",
  poweredByHeader: false,
};

export default config;
