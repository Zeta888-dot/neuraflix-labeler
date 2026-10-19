import type { LineBox, SegParams } from "./segment-core";

export type WorkerRequest =
  | {
      id: number;
      type: "load";
      bitmap: ImageBitmap;
      params: SegParams;
    }
  | {
      id: number;
      type: "process";
      params: SegParams;
    };

export type WorkerProgress = {
  id: number;
  type: "progress";
  message: string;
};

export type WorkerResult = {
  id: number;
  type: "result";
  /** Null when the working page did not change, for example a slider move. */
  page: ImageBitmap | null;
  pageChanged: boolean;
  width: number;
  height: number;
  /** Cached clockwise correction in degrees, estimated once per page. */
  angle: number;
  boxes: LineBox[];
  params: SegParams;
};

export type WorkerError = {
  id: number;
  type: "error";
  message: string;
};

export type WorkerResponse = WorkerProgress | WorkerResult | WorkerError;
