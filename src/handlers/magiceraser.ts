import { countUsers, emptyLimits, findUser } from '@/models/User'
import { spawn } from 'child_process'
import { writeFile } from 'fs'
import { Context } from 'telegraf'
const fs = require('fs')
const needle = require('needle')
const queue = require('queue')


let workers = 3

const q = queue({ concurrency: workers, autostart: true })
q.start()
var processingLimit = 1

var workerOccupied = Array(workers).fill(0)
var workerInit = Array(workers).fill(0)
var py_process = Array(workers)
for (let i = 0; i < py_process.length; i++) {
  py_process[i] = spawn('python3',
    ["./lama/bin/predict.py",
      `model.path=${process.cwd()}/lama/big-lama`,
      `indir=''`,
      `outdir=''`,
      `dataset.img_suffix=.jpg`], { windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  workerInit[i] = 0
  py_process[i].stdout.on('data', async (data) => {
    if (('' + data).includes('init full inpainting')) {
      console.log('init full inpainting done')
      workerInit[i] = 1
    }
  })
}

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
    try { await ctx.deleteMessage(msg.message_id) } catch (e) { }
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

    pythonProcess.on('close', async (code) => {
      console.log(`Finished mask extraction for ${usr_dir} with code ${code}`)
      if (code == 0) {
        fs.copyFileSync(`${usr_dir}/f_1/temp/f.jpg`, `${usr_dir}/f_1/in/f.jpg`)
        console.log(`Starting painting for ${usr_dir}`)
        usr_dir = usr_dir.slice(1)

        let ind = workerOccupied.findIndex((e) => { return e == 0 })
        if (ind < 0) {
          await delete_task_user(ctx)
          ctx.reply('server error, come back later')
          cb()
          return
        }
        while (workerInit[ind] == 0) {
          await sleep(500)
        }

        if (workerOccupied[ind] == 1) {
          await delete_task_user(ctx)
          ctx.reply('a bit busy, try one more time')
          cb()
          return
        }
        workerOccupied[ind] == 1

        let in_out = [`${process.cwd()}/${usr_dir}/f_1/in/`,
        `${process.cwd()}/${usr_dir}/f_1/out/`]

        let data_listen = async (data) => {
          console.log(`${data}`)
          if (('' + data).includes('done inpainting')) {
            try { await ctx.deleteMessage(msgexec.message_id) } catch (e) { }
            try {
              let myfile = `${process.cwd()}/${usr_dir}/f_1/out/f_mask.png`
              if (fs.existsSync(myfile)) {
                await ctx.replyWithChatAction('upload_document')
                await ctx.replyWithDocument({ source: myfile, filename: 'result.png' })
              }
            } catch (e) {
              console.log(e)
            }
            await delete_task_user(ctx)
            py_process[ind].stdout.off('data', data_listen)
            workerOccupied[ind] = 0
            cb()
          }
        }
        py_process[ind].stdout.on('data', data_listen)

        py_process[ind].on('close', async (code) => {
          console.log(`py process close`)
          if (code != 0) {
            py_process[ind] = spawn('python',
              ["./lama/bin/predict.py",
                `model.path=${process.cwd()}/lama/big-lama`,
                `indir=''`,
                `outdir=''`,
                `dataset.img_suffix=.jpg`])
            await delete_task_user(ctx)
            workerOccupied[ind] = 0
            workerInit[ind] = 0
            py_process[ind].stdout.on('data', async (data) => {
              if (('' + data).includes('init full inpainting')) {
                console.log('init full inpainting done')
                workerInit[ind] = 1
              }
            })
            try {
              await ctx.reply('server error, a bit back later')
            } catch (e) { console.log(e) }
            cb()
          }
        })

        let myBuffer = JSON.stringify(in_out)
        let mylen = myBuffer.length
        let mylenstr = mylen.toString()
        if (mylenstr.length < 3) {
          mylenstr = '0' + mylenstr
        }
        py_process[ind].stdin.write(mylenstr)
        py_process[ind].stdin.write(myBuffer)
      } else {
        //try and await
        ctx.reply(`${ctx.i18n.t('painting_error')}`, { reply_to_message_id: ctx.message.message_id })
        await delete_task_user(ctx)
        cb()
      }
    })
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
          await process_image(ctx, usr_dir)
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
    ctx.reply('Chats ' + users)
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
  try {
    if (fs.existsSync(photo)) {
      await ctx.replyWithPhoto({ source: photo, filename: 'segmentation' })
    }
  } catch (e) {
    console.log(e)
  }
}