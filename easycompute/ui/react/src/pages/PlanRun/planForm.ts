/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { NewRunRequest } from '@/features/lab/api';
import type { Project, WorkloadType } from '@/features/lab/types';

/** Plan-a-run form state (strings so inputs stay controlled while typing). */
export interface PlanForm {
  description: string;
  name: string;
  projectId: string | null;
  workloadType: WorkloadType;
  modelParamsB: string;
  datasetGb: string;
  estGpuHours: string;
  gpuTypeId: string | null;
  gpus: string;
  walltimeHours: string;
  clusterId: string | null;
  deadline: string; // datetime-local value
}

export const EMPTY_FORM: PlanForm = {
  description: '',
  name: '',
  projectId: null,
  workloadType: 'FINETUNE',
  modelParamsB: '',
  datasetGb: '',
  estGpuHours: '',
  gpuTypeId: null,
  gpus: '',
  walltimeHours: '',
  clusterId: null,
  deadline: '',
};

export const EXAMPLES = [
  'Fine-tune Llama-3-8B with LoRA on 40 GB of clinical notes, need results before the CVPR rebuttal.',
  'Pretrain a 1.3B video-language model on 2 TB of clips; 4 GPUs, about 3 days.',
  'Run a 6-day molecular dynamics simulation on 2 A100s, checkpoint every 30 minutes.',
];

const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/** `Date` → `YYYY-MM-DDTHH:mm` in local time, for datetime-local inputs. */
export const toLocalInput = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Light client-side parse of the description to pre-fill the structured fields (the server-side planner
 * re-reads the description; this only saves typing). Returns only the fields it found.
 */
export function parseDescription(text: string, projects: Project[], gpuTypeIds: string[]): Partial<PlanForm> {
  const out: Partial<PlanForm> = {};
  const t = text.toLowerCase();
  const params = /(\d+(?:\.\d+)?)\s*b\b/i.exec(text) ?? /(\d+(?:\.\d+)?)\s*-?\s*billion/i.exec(text);
  if (params) out.modelParamsB = params[1];
  const data = /(\d+(?:\.\d+)?)\s*(tb|gb)\b/i.exec(text);
  if (data) out.datasetGb = String(Number(data[1]) * (data[2].toLowerCase() === 'tb' ? 1000 : 1));
  const gpus = /(\d+)\s*(?:x\s*)?(?:[a-z0-9-]+\s+)?gpus?\b/i.exec(text) ?? /(\d+)\s*(?:x\s*)?(h100|a100|l40s|a30|a10)s?\b/i.exec(text);
  if (gpus) out.gpus = gpus[1];
  const gt = gpuTypeIds.find((id) => t.includes(id.toLowerCase().split('-')[0]));
  if (gt) out.gpuTypeId = gt;
  const days = /(\d+(?:\.\d+)?)\s*-?\s*days?\b/i.exec(text);
  const hours = /(\d+(?:\.\d+)?)\s*-?\s*(?:h|hours?)\b/i.exec(text);
  if (days) out.walltimeHours = String(Number(days[1]) * 24);
  else if (hours) out.walltimeHours = hours[1];
  if (/fine-?tun|lora|qlora|sft/.test(t)) out.workloadType = 'FINETUNE';
  else if (/pretrain|train/.test(t)) out.workloadType = 'TRAINING';
  else if (/infer|serve|eval/.test(t)) out.workloadType = 'INFERENCE';
  else if (/simulat|molecular|cfd|climate/.test(t)) out.workloadType = 'SIMULATION';
  else if (/preprocess|etl|tokeni/.test(t)) out.workloadType = 'DATA_PROCESSING';
  const proj = projects.find((p) =>
    [p.deadlineLabel, p.name].some((s) => s && s.split(/\s+/).some((w) => w.length > 3 && /[A-Z]{3,}/.test(w) && t.includes(w.toLowerCase()))),
  );
  if (proj) {
    out.projectId = proj.id;
    if (proj.deadline) out.deadline = toLocalInput(proj.deadline);
  }
  const model = /(llama|mistral|qwen|vit|resnet|bert|gpt|clip|diffusion|unet)[\w.-]*/i.exec(text);
  if (model) out.name = `${model[0]}-${out.workloadType === 'FINETUNE' ? 'ft' : (out.workloadType ?? 'run').toLowerCase()}`.toLowerCase();
  return out;
}

export function toRunRequest(f: PlanForm, labId: string): NewRunRequest {
  return {
    lab: { id: labId },
    project: f.projectId ? { id: f.projectId } : undefined,
    name: f.name.trim() || 'Untitled run',
    description: f.description.trim(),
    workloadType: f.workloadType,
    modelParamsB: num(f.modelParamsB),
    datasetGb: num(f.datasetGb),
    estGpuHours: num(f.estGpuHours),
    requestedGpus: num(f.gpus),
    requestedGpuType: f.gpuTypeId ? { id: f.gpuTypeId } : undefined,
    requestedWalltimeHours: num(f.walltimeHours),
    requestedCluster: f.clusterId ? { id: f.clusterId } : undefined,
    deadline: f.deadline ? new Date(f.deadline).toISOString() : undefined,
  };
}
