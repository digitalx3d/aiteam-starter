/**
 * Next.js runs `register()` exactly once per server instance, and it completes
 * before the server handles its first request. That ordering is the whole point
 * here: dispatch tickets stranded by the previous process must be corrected on
 * disk before any route handler reads them into its cache.
 */
export async function register(): Promise<void> {
  // The Edge runtime has no child processes, no pids, and no fs. Node only,
  // and imported only here so the Edge bundle never pulls node modules in.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
