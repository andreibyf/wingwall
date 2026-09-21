import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes, getChain, getFlyLivePricing } from "./routes";
import { buildSignalSnapshot } from "./copilot";
import { installOperatorAuth } from "./operator-auth";
import { startPaperWorkers, workerStatus } from "./paper-worker";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { ensureSchema } from "./storage";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
// Auth routes are before response logging. Cookies and credentials are never logged.
installOperatorAuth(app);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // Do not log full positions, chat transcripts, or account settings.

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Bootstrap Postgres tables (CREATE TABLE IF NOT EXISTS + additive column migration)
  // before accepting traffic. Must complete before registerRoutes/listen so the very
  // first request never races an empty database.
  await ensureSchema();

  await registerRoutes(httpServer, app);
  app.get("/health/automation",async(_req,res)=>{
    try {
      const status=await workerStatus();
      res.status(status.healthy?200:503).json({healthy:status.healthy,heartbeatFresh:status.heartbeatFresh,mode:status.mode});
    } catch {res.status(503).json({healthy:false});}
  });

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    // A schema rejection is the client sending something invalid, not the server failing.
    // It used to fall through to a 500 with the issue list stuffed into `message` as a JSON
    // string, so a form could only report "something went wrong" instead of naming the bad
    // field. Now it comes back as a 400 with the issues addressable per field.
    const issues = err?.issues ?? err?.errors;
    if (err?.name === "ZodError" && Array.isArray(issues)) {
      const fieldErrors = issues.map((i: any) => ({
        field: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
        message: String(i.message ?? "invalid value"),
      }));
      console.warn("Validation rejected:", fieldErrors);
      return res.status(400).json({
        message: fieldErrors.map((f: any) => (f.field ? `${f.field}: ${f.message}` : f.message)).join(" "),
        fieldErrors,
      });
    }

    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      const stop=startPaperWorkers({
        fetchChain:getChain,quote:getFlyLivePricing,
        buildSnapshot:()=>buildSignalSnapshot(getFlyLivePricing,getChain),
      });
      process.once("SIGTERM",()=>{stop();httpServer.close();});
    },
  );
})();
