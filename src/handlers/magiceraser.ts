import { countUsers, emptyLimits, findUser } from '@/models/User'
import { spawn } from 'child_process'
import { writeFile } from 'fs'
import { Context } from 'telegraf'
const fs = require('fs')
const needle = require('needle')
const queue = require('queue')

let workers = 1

const q = queue({ concurrency: workers, autostart: true })
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
    let usr = await findUser(ctx.from.id)
    if (usr.jobs == 0) {
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
  user.jobs -= 1
  user = await (user as any).save()
}

async function process_image(ctx: Context, usr_dir: string) {
  let msg = await ctx.reply(`${ctx.i18n.t('queue_task')}`)
  q.push(async (cb) => {
    ctx.deleteMessage(msg.message_id).catch((e) => { })
    let msgexec = await ctx.reply(`${ctx.i18n.t('execution_task')}`)

    const pythonProcess = spawn('python3',
      ["./lama/bin/mask.py",
        `${usr_dir}/f_1/temp`,
        `f_mask.jpg`,
        `f.jpg`,
        `${usr_dir}/f_1/in`])
    pythonProcess.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`)
    })

    await new Promise( (resolve) => {
      pythonProcess.on('close', async (code) => {
      console.log(`Finished mask extraction for ${usr_dir} with code ${code}`)
      if (code == 0) {
        fs.copyFileSync(`${usr_dir}/f_1/temp/f.jpg`, `${usr_dir}/f_1/in/f.jpg`)
        console.log(`Starting painting for ${usr_dir}`)
        usr_dir = usr_dir.slice(1)

        let py_process = spawn('python3',
          ["./lama/bin/predict.py",
            `model.path=${process.cwd()}/lama/big-lama`,
            `indir='${process.cwd()}/${usr_dir}/f_1/in/'`,
            `outdir='${process.cwd()}/${usr_dir}/f_1/out/'`,
            `dataset.img_suffix=.jpg`])
        let proc_out = ''
        py_process.stdout.on('data', async (data) => {
          // console.log(`out: ${data}`)
          proc_out+=data
        })
        
        py_process.on('error', function(err) {
          console.log('Full err: ' + err)
          ctx.telegram.sendMessage(180001222, `Full err: ${err}`).catch(e => { })
        })
        
        let proc_out_err = ''
        py_process.stderr.on('data', async (data) => {
          proc_out_err+=data
        })
        await new Promise( (resolve) => {
          py_process.on('close', async (code) => {
          console.log(`Finished painting for ${usr_dir} with code ${code}`)
          if (code == 0) {
            ctx.deleteMessage(msgexec.message_id).catch(e => { })

            let myfile = `${process.cwd()}/${usr_dir}/f_1/out/f_mask.png`
            if (fs.existsSync(myfile)) {
              ctx.replyWithChatAction('upload_document').catch(e => { })
              ctx.replyWithDocument({ source: myfile, filename: 'result.png' }).catch(e => { })
            }
            await delete_task_user(ctx)
            cb()
          } else {
            ctx.reply('Server error, please retry later, we are analyzing the problem').catch(e => { })
            ctx.telegram.sendMessage(180001222, `Server inpainting error for ${ctx.dbuser.id}, check please`).catch(e => { })
            if (proc_out.length>4000){
              ctx.telegram.sendMessage(180001222, `Here is what system err have printed: ${proc_out.substr(-500)}`).catch(e => { })
            }
            ctx.telegram.sendMessage(180001222, `Here is what system err have printed: ${proc_out_err}`).catch(e => { })
            await delete_task_user(ctx)
            cb()
          }
        }) })
      } else {
        ctx.reply(`${ctx.i18n.t('painting_error')}`, { reply_to_message_id: ctx.message.message_id }).catch(e => { })
        ctx.telegram.sendMessage(180001222, `Server mask error for ${ctx.dbuser.id}, please retry later`).catch(e => { })
        await delete_task_user(ctx)
        cb()
      }
    }) })
  })
}

function createFolderStructure(ctx: Context) {
  let usr_dir = `./data_folder/${ctx.dbuser.id}`
  let usr_folders = [`${usr_dir}/`]
  for (let i = 0; i < processingLimit; i++) {
    usr_folders.push(`${usr_dir}/`)
    usr_folders.push(`${usr_dir}/f_${i + 1}`)
    usr_folders.push(`${usr_dir}/f_${i + 1}/in`)
    usr_folders.push(`${usr_dir}/f_${i + 1}/out`)
    usr_folders.push(`${usr_dir}/f_${i + 1}/temp`)
  }

  for (let folder of usr_folders) {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder)
    }
  }
  return usr_dir
}

export async function processPhoto(ctx: Context) {
  if (ctx.dbuser.jobs >= processingLimit) {
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

    var usr_dir = createFolderStructure(ctx)
    if (!('reply_to_message' in ctx.message)
      || (('reply_to_message' in ctx.message) && !ctx.message.reply_to_message)) {
      fs.rmSync(usr_dir, { recursive: true, force: true });
      usr_dir = createFolderStructure(ctx)
    }

    const f1 = `${usr_dir}/f_1/temp/f.jpg`
    const f2 = `${usr_dir}/f_1/temp/f_mask.jpg`
    var f_fin = fs.existsSync(f1) ? f2 : f1
    await writeFile(`${f_fin}`, result.body, () => { })

    if (f_fin == f2) {
      if (ctx.dbuser.jobs < processingLimit) {
        if (ctx.dbuser.jobs == 0) {
          let user = ctx.dbuser
          user.jobs += 1
          user = await (user as any).save()
          console.log(`Starting mask extraction for ${usr_dir}`)

          chatAction(ctx)
          process_image(ctx, usr_dir)
        }
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

export async function countAllUsers(ctx: Context) {
  if (ctx.message.from.id == 180001222) {
    let users = await countUsers()
    ctx.reply('Chats ' + users).catch(e => { })
  }
}


export async function resetLimits(ctx: Context) {
  if (ctx.message.from.id == 180001222) {
    await emptyLimits()
  }
}

export async function sendSegmentationResult(ctx: Context) {
  let usr_dir = `data_folder/${ctx.dbuser.id}`;
  let photo = `${process.cwd()}/${usr_dir}/f_1/temp/f_mask_confirm.png`
  if (fs.existsSync(photo)) {
    ctx.replyWithPhoto({ source: photo, filename: 'segmentation' }).catch(e => { })
  }
}
