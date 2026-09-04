/**
 * Wire contract between the durable step workflow and the worker activities
 * that execute it. Infrastructure-free: the workflow sandbox and the Node
 * worker both import these types.
 */
export interface WorkflowStepExecution {
  id: string;
  userId: string | null;
  accountId: string | null;
  runId: string | null;
  stepType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  activityTaskQueue: string;
}

export interface WorkflowStepResult {
  result: Record<string, unknown>;
}

export interface WorkflowStepActivities {
  runWorkflowStepActivity(
    input: WorkflowStepExecution,
  ): Promise<WorkflowStepResult>;
  reconcileWorkflowStepFailureActivity(
    input: WorkflowStepExecution,
  ): Promise<void>;
}
