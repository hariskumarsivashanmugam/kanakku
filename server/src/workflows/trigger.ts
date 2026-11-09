/**
 * Starts the Kanakku Autopilot task on Render Workflows, when configured.
 * Used by the web service after PayPal webhooks, and by the hourly cron job.
 */
export async function startWorkflowRun(): Promise<boolean> {
  const slug = process.env.RENDER_WORKFLOW_TASK; // e.g. "kanakku-workflows/autopilot"
  if (!slug || !process.env.RENDER_API_KEY) return false;
  const { Render } = await import("@renderinc/sdk");
  const render = new Render();
  await render.workflows.startTask(slug, [{ trigger: "external" }]);
  return true;
}

// Run directly (the cron job): `tsx src/workflows/trigger.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkflowRun()
    .then((started) => {
      console.log(started ? "Started the Autopilot workflow run." : "RENDER_WORKFLOW_TASK or RENDER_API_KEY is not set.");
      process.exit(started ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
