/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

export interface Meta {
  created?: string;
  updated?: string;
  createdBy?: string;
}

export interface GpuType {
  id: string;
  version?: number;
  name: string;
  vendor?: string;
  memoryGb?: number;
  fp16Tflops?: number;
  relativeThroughput?: number;
  costPerGpuHourUsd?: number;
  meta?: Meta;
}

export interface FetchResult<T> {
  objs?: T[];
  count?: number;
  hasMore?: boolean;
}
