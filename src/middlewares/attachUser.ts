import { countUsers, findUser } from '@/models'
import { Context } from 'telegraf'

export async function attachUser(ctx: Context, next: () => void) {
  
  let old_nr_users = await countUsers()
  ctx.dbuser = await findUser(ctx.from.id)
  //check if number of users divides 100
  let new_nr_users = await countUsers()
  if (old_nr_users!=new_nr_users &&  new_nr_users % 100 == 0) {
    ctx.telegram.sendMessage(180001222, `${new_nr_users} users`).catch((e) => {})
  }
  return next()
}
