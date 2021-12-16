import { countUsers, findUser } from '@/models'
import { Context } from 'telegraf'

export async function attachUser(ctx: Context, next: () => void) {
  ctx.dbuser = await findUser(ctx.from.id)
  //check if number of users divides 100
  let nr_users = await countUsers()
  if (nr_users % 100 == 0) {
    ctx.telegram.sendMessage(180001222, `${nr_users} users`)
  }
  return next()
}
