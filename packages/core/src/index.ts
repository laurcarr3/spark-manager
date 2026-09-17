export type ModelStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface Model {
  id: string;
  name: string;
  status: ModelStatus;
}
