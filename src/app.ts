import { localeActions } from './handlers/language'
// Setup @/ aliases for modules
import 'module-alias/register'
// Config dotenv
import * as dotenv from 'dotenv'
dotenv.config({ path: `${__dirname}/../.env` })
// Dependencies
import { bot } from '@/helpers/bot'
import { ignoreOldMessageUpdates } from '@/middlewares/ignoreOldMessageUpdates'
import { sendHelp } from '@/handlers/sendHelp'
import { i18n, attachI18N } from '@/helpers/i18n'
import { setLanguage, sendLanguage } from '@/handlers/language'
import { attachUser } from '@/middlewares/attachUser'
import { countAllUsers, getSeg, processPhoto, resetLimits, setProcessLimit } from './handlers/magiceraser'
import { emptyLimits } from './models'

// Middlewares
bot.use(ignoreOldMessageUpdates)
bot.use(attachUser)
bot.use(i18n.middleware(), attachI18N)
// Commands
bot.command(['help', 'start'], sendHelp)
bot.command('language', sendLanguage)
bot.command('limit', setProcessLimit)
bot.command('countChats', countAllUsers)
bot.command('reset', resetLimits)
bot.command('segmentation', getSeg)


bot.on('photo',processPhoto)
bot.on('message',processPhoto)
// Actions
bot.action(localeActions, setLanguage)
// Errors
bot.catch(console.error)
// Start bot
bot.launch().then(async () => {
  await emptyLimits()
  console.info(`Bot ${bot.botInfo.username} is up and running`)
})
