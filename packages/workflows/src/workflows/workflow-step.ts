import { proxyActivities } from "@temporalio/workflow";

import type {
  WorkflowStepActivities,
  WorkflowStepExecution,
  WorkflowStepResult,
} from "../contracts/workflow-step";

const activityExecutionOptions = {
  startToCloseTimeout: "15 minutes",
  scheduleToCloseTimeout: "2 hours",
} as const;

export async function workflowStepWorkflow(
  input: WorkflowStepExecution,
): Promise<WorkflowStepResult> {
  const remainingAttempts = Math.max(input.maxAttempts - input.attempts, 1);
  const { runWorkflowStepActivity } = proxyActivities<WorkflowStepActivities>({
    ...activityExecutionOptions,
    taskQueue: input.activityTaskQueue,
    retry: {
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumAttempts: remainingAttempts,
    },
  });
  try {
    return await runWorkflowStepActivity(input);
  } catch (error) {
    const { reconcileWorkflowStepFailureActivity } =
      proxyActivities<WorkflowStepActivities>({
        ...activityExecutionOptions,
        taskQueue: input.activityTaskQueue,
        retry: {
          initialInterval: "1 second",
          backoffCoefficient: 2,
          maximumAttempts: 10,
        },
      });
    await reconcileWorkflowStepFailureActivity(input);
    throw error;
  }
}
