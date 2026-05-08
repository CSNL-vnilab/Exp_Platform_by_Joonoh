import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Force the payment-claim xlsx templates into the Vercel function
  // bundle. Next.js's static analysis traces literal `fs.readFile` paths
  // in most cases, but template-filler.ts builds the path with
  // `path.join(process.cwd(), …)` which is opaque to the tracer. Without
  // this hint the templates are missing at runtime and the claim
  // bundle build fails with ENOENT inside the function.
  outputFileTracingIncludes: {
    "/api/experiments/[experimentId]/payment-claim": [
      "./src/lib/payments/templates/*.xlsx",
    ],
    "/api/experiments/[experimentId]/payment-export/**/*": [
      "./src/lib/payments/templates/*.xlsx",
    ],
  },
};

export default nextConfig;
