import { z } from 'zod'
import { Day, Uuid } from '../http'

export const ShareLevelZ = z.enum(['time', 'cards', 'detailed'])
export const RoleZ = z.enum(['owner', 'admin', 'member', 'viewer'])

export const ENTITIES = ['card', 'card_project', 'observation', 'standup', 'day_goal', 'user_doc', 'project', 'project_member'] as const

export const ChangeZ = z.object({
  entity: z.enum(ENTITIES),
  id: z.string().min(1).max(200),
  deviceId: z.string().min(1).max(100),
  hlc: z.string().min(1).max(200),
  deleted: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  fieldHlc: z.record(z.string(), z.string().max(200)).optional(),
})

export const PushZ = z.object({ changes: z.array(z.unknown()).max(1000) })

const ts = z.number().int().min(0).max(8_640_000_000_000)
const text = (max: number) => z.string().max(max)
const jsonObject = (maxBytes: number) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= maxBytes, `object larger than ${maxBytes} bytes`)

export const CardDataZ = z
  .object({
    userId: Uuid.optional(),
    startTs: ts.optional(),
    endTs: ts.optional(),
    day: Day.optional(),
    title: text(2_000).optional(),
    summary: text(20_000).optional(),
    detailedSummary: text(100_000).optional(),
    category: text(200).optional(),
    subcategory: text(200).optional(),
    metadata: jsonObject(512_000).optional(),
    isError: z.boolean().optional(),
  })
  .loose()

export const CardProjectDataZ = z
  .object({
    cardId: Uuid,
    projectId: Uuid,
    share: z.number().min(0).max(1).default(1),
    source: z.enum(['manual', 'rule', 'llm']).default('manual'),
    confidence: z.number().min(0).max(1).default(1),
    confirmed: z.boolean().default(false),
  })
  .loose()

export const ObservationDataZ = z
  .object({ userId: Uuid.optional(), startTs: ts, endTs: ts, text: text(50_000) })
  .loose()

/** standup / day_goal: payload is the whole data object minus userId/day. */
export const DayDocDataZ = z.object({ userId: Uuid.optional(), day: Day.optional() }).loose()
export const UserDocDataZ = z.object({ userId: Uuid.optional(), kind: z.string().min(1).max(64).optional() }).loose()

export const ProjectRulesZ = z
  .object({
    apps: z.array(z.string().max(200)).max(200).optional(),
    domains: z.array(z.string().max(200)).max(200).optional(),
    titleKeywords: z.array(z.string().max(200)).max(200).optional(),
    repos: z.array(z.string().max(300)).max(200).optional(),
  })
  .loose()

export const OdooMappingZ = z.object({
  projectId: z.number().int().positive().optional(),
  taskId: z.number().int().positive().optional(),
  projectName: z.string().max(300).optional(),
  taskName: z.string().max(300).optional(),
})

export const ProjectDataZ = z.object({
  workspaceId: Uuid,
  name: z.string().min(1).max(200),
  color: z.string().max(32).default(''),
  icon: z.string().max(16).optional(),
  description: z.string().max(5_000).default(''),
  rules: ProjectRulesZ.default({}),
  defaultShare: ShareLevelZ.default('time'),
  odoo: OdooMappingZ.nullish(),
  archived: z.boolean().default(false),
})

export const ProjectMemberDataZ = z.object({
  projectId: Uuid,
  userId: Uuid,
  shareLevel: ShareLevelZ.nullable().default(null),
})
