import type { Ctx } from '../context'
import { feedAudience, type Effects } from './engine'

/** After commit: `changed` to every user who can pull something new, `feed` to members of affected projects. */
export async function publishEffects(ctx: Ctx, fx: Effects): Promise<void> {
  if (fx.notifyUsers.size) ctx.hub.publish(fx.notifyUsers, 'changed', {})
  if (fx.feedProjects.size) {
    const audience = await feedAudience(ctx.db, [...fx.feedProjects])
    for (const [userId, projectIds] of audience) ctx.hub.publish([userId], 'feed', { projectIds })
  }
}
