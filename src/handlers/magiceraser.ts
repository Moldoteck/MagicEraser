import { countUsers } from '@/models/User'
import { spawn } from 'child_process'
import { writeFile } from 'fs'
import { Context } from 'telegraf'
const fs = require('fs')
const needle = require('needle')
const queue = require('queue')
const q = queue({ concurrency: 5, autostart: true })
q.start()
var processingLimit = 1

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function chatAction(ctx: Context) {
  while (true) {
    try {
      await ctx.replyWithChatAction('typing')
    } catch (e) { console.log(e) }
    await sleep(4000)
    if (ctx.dbuser.jobs.length == 0) {
      break
    }
  }
}

async function get_file(ctx: Context) {
  if ('document' in ctx.message && (ctx.message.document.mime_type == 'image/png' || ctx.message.document.mime_type == 'image/jpeg')) {
    return await ctx.telegram.getFile(ctx.message.document.file_id)
  } else if ('photo' in ctx.message) {
    return await ctx.telegram.getFile(ctx.message.photo.slice(-1)[0].file_id)
  }
  return undefined
}

async function delete_task_user(ctx: Context) {
  let user = ctx.dbuser
  user.jobs.pop()
  user = await (user as any).save()
  ctx.dbuser.save()
}

async function process_image(ctx: Context, usr_dir: string) {
  let msg = await ctx.reply(`${ctx.i18n.t('queue_task')}`)
  q.push(async (cb) => {
    try { ctx.deleteMessage(msg.message_id) } catch (e) { }
    let msgexec = await ctx.reply(`${ctx.i18n.t('execution_task')}`)
    console.log('' + usr_dir)
    console.log('' + process.cwd())
    const pythonProcess = spawn('python3',
      ["./lama/bin/mask.py",
        `${usr_dir}`,
        `f_1_mask.jpg`,
        `f_1.jpg`])

    pythonProcess.stdout.on('data', async (data) => {
      console.log(`stdout2: ${data}`);
    });
    pythonProcess.stderr.on('data', (data) => {
      console.error(`stderr2: ${data}`);
    });
    pythonProcess.on('close', async (code) => {
      console.log(`Finished mask extraction for ${usr_dir} with code ${code}`)
      if (code == 0) {
        fs.copyFile(`${usr_dir}/f_1.jpg`, `${usr_dir}/out/f_1.jpg`, (err) => { })
        fs.copyFile(`${usr_dir}/f_1_mask.png`, `${usr_dir}/out/f_1_mask.png`, (err) => { })
        console.log(`Starting painting for ${usr_dir}`)
        const pythonProcess2 = spawn('python3',
          ["./lama/bin/predict.py",
            `model.path=${process.cwd()}/lama/big-lama`,
            `indir=${process.cwd()}/${usr_dir.substring(1)}/out`,
            `outdir=${process.cwd()}/${usr_dir.substring(1)}/out`,
            `dataset.img_suffix=.jpg`])

        pythonProcess2.stdout.on('data', async (data) => {
          console.log(`stdout2: ${data}`)
        });
        pythonProcess2.stderr.on('data', (data) => {
          console.error(`stderr2: ${data}`)
        });

        pythonProcess2.on('close', async (code) => {
          console.log(`Finished painting for ${usr_dir} with code ${code}`)
          try { ctx.deleteMessage(msgexec.message_id) } catch (e) { }
          if (code == 0) {
            try {
              ctx.replyWithChatAction('upload_document')
              ctx.replyWithDocument({ source: `${process.cwd()}/${usr_dir.substring(1)}/out/f_1_mask.png`, filename: 'result.png' })
              await delete_task_user(ctx)
              cb()
            } catch (e) {
              console.log(e)
              await delete_task_user(ctx)
              cb()
            }
          } else {
            ctx.reply(`${ctx.i18n.t('painting_error')}`, { reply_to_message_id: ctx.message.message_id })
            await delete_task_user(ctx)
            cb()
          }
        })
      } else {
        ctx.reply(`${ctx.i18n.t('painting_error')}`, { reply_to_message_id: ctx.message.message_id })
        await delete_task_user(ctx)
        cb()
      }
    })
  })
}

export async function processPhoto(ctx: Context) {
  if (ctx.dbuser.jobs.length >= processingLimit) {
    ctx.reply(`${ctx.i18n.t('wait_task')}`)
    return
  }

  let file = await get_file(ctx)
  if (file) {
    if ('document' in ctx.message && ctx.dbuser.id != 180001222) {
      ctx.reply(`${ctx.i18n.t('unsupported_file')}`)
      return
    }
    let result = await needle('get', `https://api.telegram.org/file/bot${process.env.TOKEN}/${file.file_path}`)

    var usr_dir = `./data_folder/${ctx.dbuser.id}`;
    if (!fs.existsSync(usr_dir)) {
      fs.mkdirSync(usr_dir);
    }
    if (!('reply_to_message' in ctx.message)
      || (('reply_to_message' in ctx.message) && !ctx.message.reply_to_message)) {
      fs.rmSync(usr_dir, { recursive: true, force: true });
      fs.mkdirSync(usr_dir)
    }

    const f1 = `${usr_dir}/f_1.jpg`
    const f2 = `${usr_dir}/f_1_mask.jpg`
    var f_fin = fs.existsSync(f1) ? f2 : f1
    await writeFile(`${f_fin}`, result.body, () => { })

    if (f_fin == f2) {
      if (ctx.dbuser.jobs.length < processingLimit) {

        if (ctx.dbuser.jobs.length == 0) {
          chatAction(ctx)
        }

        let user = ctx.dbuser
        user.jobs.unshift(Date.now())
        user = await (user as any).save()
        ctx.dbuser.save()

        var out_dir = usr_dir + '/out'
        if (!fs.existsSync(out_dir)) {
          fs.mkdirSync(out_dir);
        }
        console.log(`Starting mask extraction for ${usr_dir}`)

        await process_image(ctx, usr_dir)
      }
    } else {
      ctx.reply(`${ctx.i18n.t('first_image')}`, { reply_to_message_id: ctx.message.message_id })
    }
  }
}

export async function setProcessLimit(ctx: Context) {
  if (ctx.dbuser.id == 180001222) {
    if ('text' in ctx.message) {
      processingLimit = parseInt(ctx.message.text)
      ctx.reply(`Processing limit set to ${processingLimit}`)
    }
  }
}

export async function countChats(ctx: Context) {
  if (ctx.message.from.id == 180001222) {
    let chats = await countUsers()
    ctx.reply('Chats ' + chats.length)
  }
}