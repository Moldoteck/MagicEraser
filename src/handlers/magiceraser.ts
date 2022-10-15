import { countUsers, deleteUser, findAllUsers } from '@/models/User'
import { spawn } from 'child_process'
import { writeFile } from 'fs'
import Context from '@/models/Context'
const fs = require('fs')
const needle = require('needle')
const queue = require('queue')
import { v4 } from 'uuid'
import { InputFile, Message } from 'grammy/out/platform.node'
import { Error } from 'mongoose'

let workers = 2

const q = queue({ concurrency: workers, autostart: true })
q.start()
var processingLimit = 1

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
async function chatAction(ctx: Context) {
  if (ctx.dbuser.jobs > 1) {
    return
  }
  while (true) {
    try {
      await ctx.replyWithChatAction('typing')
    } catch (e) {
      console.log(e)
    }

    await sleep(4000)
    if (ctx.dbuser.jobs == 0) {
      break
    }
  }
}

async function get_file(ctx: Context) {
  if (ctx.msg?.photo) {
    return await ctx.getFile()
    // ctx.telegram.getFile(ctx.message.photo.slice(-1)[0].file_id)
  }
  return undefined
}

async function delete_task_user(ctx: Context, path: string) {
  try {
    fs.rmSync(path, { recursive: true, force: true })
  } catch (e) {
    console.log(e)
  }
  ctx.dbuser.jobs -= 1
  await ctx.dbuser.save()
}

async function start_inpainting(
  ctx: Context,
  usr_dir: string,
  firstID: string,
  secondID: string
) {
  let msg: Message.TextMessage | undefined = undefined
  try {
    //Send start operation
    msg = await ctx.reply(`${ctx.i18n.t('queue_task')}`)
  } catch (e) {
    console.log(e)
  }

  q.push(async (cb: any) => {
    //delete start operation message
    ctx.chat?.id && msg?.message_id
      ? ctx.api.deleteMessage(ctx.chat?.id, msg?.message_id).catch((e) => {
          console.log(e)
        })
      : ''

    let msgexec: Message.TextMessage | undefined = undefined
    try {
      //Send executing operation
      msgexec = await ctx.reply(`${ctx.i18n.t('execution_task')}`)
    } catch (e) {
      console.log(e)
    }

    const pythonProcess = spawn('python3', [
      './lama/bin/mask.py',
      `${usr_dir}/${firstID}/${secondID}/temp`,
      `f_mask.jpg`,
      `f.jpg`,
      `${usr_dir}/${firstID}/${secondID}/in`,
    ])
    pythonProcess.stderr.on('data', (data) => {
      console.log(`stderr: ${data}`)
    })

    await new Promise((resolve) => {
      pythonProcess.on('close', async (code) => {
        console.log(`Finished mask extraction for ${usr_dir} with code ${code}`)
        if (code == 0) {
          console.log(`Starting painting for ${usr_dir}`)
          usr_dir = usr_dir.slice(1)

          let py_process = spawn('python3', [
            './lama/bin/predict.py',
            `model.path=${process.cwd()}/lama/big-lama`,
            `indir='${process.cwd()}/${usr_dir}/${firstID}/${secondID}/in/'`,
            `outdir='${process.cwd()}/${usr_dir}/${firstID}/${secondID}/out/'`,
            `dataset.img_suffix=.jpg`,
          ])
          let proc_out = ''
          py_process.stdout.on('data', async (data) => {
            proc_out += data
          })

          py_process.on('error', function (err) {
            console.log('Full err: ' + err)
            //todo: create method sendadmin
            ctx.api.sendMessage(180001222, `Full err: ${err}`).catch((e) => {
              console.log(e)
            })
          })

          let proc_out_err = ''
          py_process.stderr.on('data', async (data) => {
            proc_out_err += data
          })
          await new Promise((resolve) => {
            py_process.on('close', async (code) => {
              console.log(`Finished painting for ${usr_dir} with code ${code}`)
              if (code == 0) {
                ctx.chat?.id && msgexec?.message_id
                  ? ctx.api
                      .deleteMessage(ctx.chat?.id, msgexec.message_id)
                      .catch((e) => {})
                  : ''

                let myfile = `${process.cwd()}/${usr_dir}/${firstID}/${secondID}/out/f_mask.png`
                if (fs.existsSync(myfile)) {
                  ctx.replyWithChatAction('upload_document').catch((e) => {})
                  let resultFile: InputFile = new InputFile(
                    myfile,
                    'result.png'
                  )
                  await ctx.replyWithDocument(resultFile).catch((e) => {
                    console.log(e)
                  })
                  ctx.reply(`${ctx.i18n.t('new_send')}`).catch((e) => {
                    console.log(e)
                  })
                }
                await delete_task_user(
                  ctx,
                  `${process.cwd()}/${usr_dir}/${firstID}/${secondID}`
                )
                cb()
              } else {
                ctx
                  .reply(
                    'Server error, please retry later, we are analyzing the problem'
                  )
                  .catch((e) => {
                    console.log(e)
                  })
                ctx.api
                  .sendMessage(
                    180001222,
                    `Server inpainting error for ${ctx.dbuser.id}, check please`
                  )
                  .catch((e) => {
                    console.log(e)
                  })
                if (proc_out.length > 4000) {
                  ctx.api
                    .sendMessage(
                      180001222,
                      `Here is what system err have printed: ${proc_out.substr(
                        -500
                      )}`
                    )
                    .catch((e) => {
                      console.log(e)
                    })
                }
                ctx.api
                  .sendMessage(
                    180001222,
                    `Here is what system err have printed: ${proc_out_err}`
                  )
                  .catch((e) => {
                    console.log(e)
                  })
                await delete_task_user(
                  ctx,
                  `${process.cwd()}/${usr_dir}/${firstID}/${secondID}`
                )
                cb()
              }
            })
          })
        } else {
          ctx
            .reply(`${ctx.i18n.t('painting_error')}`, {
              reply_to_message_id: ctx.message?.message_id,
              allow_sending_without_reply: true,
            })
            .catch((e) => {
              console.log(e)
            })
          ctx.api
            .sendMessage(
              180001222,
              `Server mask error for ${ctx.dbuser.id}, please retry later`
            )
            .catch((e) => {
              console.log(e)
            })
          await delete_task_user(
            ctx,
            `${process.cwd()}/${usr_dir}/${firstID}/${secondID}`
          )
          cb()
        }
      })
    })
  })
}

function createFolderStructure(ctx: Context) {
  let usr_dir = `./data_folder/${ctx.dbuser.id}`
  let usr_folders = [`${usr_dir}/`]

  let id = v4()

  usr_folders.push(`${usr_dir}/${id}`)

  for (let folder of usr_folders) {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder)
    }
  }
  return [usr_dir, id]
}

export async function processPhoto(ctx: Context) {
  if (ctx.dbuser.originalPhoto.length == 0) {
    let fileInfo = await get_file(ctx)
    if (fileInfo) {
      var [usr_dir, unique_id] = createFolderStructure(ctx)
      ctx.dbuser.originalPhoto = unique_id
      await ctx.dbuser.save()

      let result = await needle(
        'get',
        `https://api.telegram.org/file/bot${process.env.TOKEN}/${fileInfo.file_path}`
      )

      const toSave = `${usr_dir}/${unique_id}/f.jpg`
      await writeFile(`${toSave}`, result.body, () => {})

      ctx
        .reply(`${ctx.i18n.t('first_image')}`, {
          reply_to_message_id: ctx.msg?.message_id,
          allow_sending_without_reply: true,
        })
        .catch((e) => {
          console.log(e)
        })
      return
    }

    return
  }

  if (ctx.dbuser.jobs > processingLimit) {
    ctx.reply(`${ctx.i18n.t('wait_task')}`).catch((e) => {})
    return
  }
  ctx.dbuser.jobs++
  await ctx.dbuser.save()
  let fileInfo = await get_file(ctx)
  if (fileInfo) {
    const firstID = ctx.dbuser.originalPhoto
    let result = await needle(
      'get',
      `https://api.telegram.org/file/bot${process.env.TOKEN}/${fileInfo.file_path}`
    )

    const usr_dir = `./data_folder/${ctx.dbuser.id}`

    console.log(`Starting mask extraction for ${usr_dir}`)

    const secondID = v4()
    const secondIDFolder = `${usr_dir}/${firstID}/${secondID}/`
    let manyFolders = [secondIDFolder]
    manyFolders.push(`${secondIDFolder}/in`)
    manyFolders.push(`${secondIDFolder}/out`)
    manyFolders.push(`${secondIDFolder}/temp`)

    for (let folder of manyFolders) {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder)
      }
    }
    const toSave = `${secondIDFolder}/temp/f_mask.jpg`
    await writeFile(`${toSave}`, result.body, () => {})

    fs.copyFileSync(`${usr_dir}/${firstID}/f.jpg`, `${secondIDFolder}/in/f.jpg`)
    fs.copyFileSync(
      `${usr_dir}/${firstID}/f.jpg`,
      `${secondIDFolder}/temp/f.jpg`
    )
    chatAction(ctx)

    start_inpainting(ctx, usr_dir, firstID, secondID).catch((e) => {})
  } else {
    // await delete_task_user(ctx, `${usr_dir}/${firstID}/${secondID}`)
    ctx.dbuser.jobs--
    await ctx.dbuser.save()
  }
}

export async function setProcessLimit(ctx: Context) {
  if (ctx.dbuser.id == 180001222) {
    if (ctx.msg?.text) {
      processingLimit = parseInt(ctx.msg.text)
      ctx.reply(`Processing limit set to ${processingLimit}`).catch((e) => {})
    }
  }
}

export async function countAllUsers(ctx: Context) {
  if (ctx.from?.id == 180001222) {
    let total = 0
    let totalSend = 0
    let users = await findAllUsers()
    total = users.length
    for (let privateUser of users) {
      try {
        await ctx.api.sendChatAction(privateUser.id, 'typing')
        totalSend++
      } catch (err: any) {
        const stringErr: string = err.toString()
        if (stringErr.includes('403: Forbidden:')) {
          console.log('Will delete')
          deleteUser(privateUser.id).catch((e) => {
            console.log(e)
          })
        } else if (stringErr.includes('429: Too Many:')) {
          console.log('Too many requests')
        } else {
          console.log(err)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    ctx
      .reply(`Total users ${totalSend}:${total}`, {
        disable_notification: true,
      })
      .catch((err) => {
        console.log(err)
      })
  }
}

// export async function resetLimits(ctx: Context) {
//   if (
//     ctx.message.from.id == 180001222 &&
//     'reply_to_message' in ctx.message &&
//     'text' in ctx.message.reply_to_message
//   ) {
//     let text = ctx.message.reply_to_message.text
//     let id = text.split(', check')[0].split(' ').slice(-1)[0]
//     let id_nr = parseInt(id)
//     if (!isNaN(id_nr)) {
//       await emptyLimitsUser(id_nr)
//     } else {
//       ctx.reply(`Can't parse id ${id}`).catch((e) => {})
//     }
//   }
// }

// export async function sendSegmentationResult(ctx: Context) {
//   let usr_dir = `data_folder/${ctx.dbuser.id}`
//   let photo = `${process.cwd()}/${usr_dir}/f_1/temp/f_mask_confirm.png`
//   if (fs.existsSync(photo)) {
//     ctx
//       .replyWithPhoto({ source: photo, filename: 'segmentation' })
//       .catch((e) => {})
//   }
// }
//method to delete folders

// fs.rmSync(`${usr_dir}/${unique_id}`, { recursive: true, force: true })
export async function handleNew(ctx: Context) {
  ctx.dbuser.originalPhoto = ''
  await ctx.dbuser.save()
  ctx.reply(`Ok`).catch((e) => {
    console.log(e)
  })
}

export async function handleReset(ctx: Context) {
  ctx.dbuser.originalPhoto = ''
  ctx.dbuser.jobs = 0
  await ctx.dbuser.save()
  ctx.reply(`Ok`).catch((e) => {
    console.log(e)
  })
}

export async function notifyAllChats(ctx: Context) {
  if (ctx.from?.id == 180001222 && ctx.message?.reply_to_message?.text) {
    let msg = ctx.message.reply_to_message.text
    if (msg) {
      let total = 0
      let totalSend = 0
      let users = await findAllUsers()
      total = users.length
      for (let privateUser of users) {
        let canSend = false
        try {
          await ctx.api.sendChatAction(privateUser.id, 'typing')
          canSend = true
        } catch (err) {
          console.log(err)
        }

        await new Promise((resolve) => setTimeout(resolve, 4000))
        if (canSend) {
          ctx.api
            .sendMessage(privateUser.id, msg, { disable_notification: true })
            .catch((err) => {
              console.log(err)
              totalSend--
              ctx
                .reply(err.toString(), { disable_notification: true })
                .catch((err) => {
                  console.log(err)
                  console.log('user id ', privateUser.id)
                })
            })
          totalSend++
          //sleep 1 second
        }
      }
      ctx
        .reply(`Total sent ${totalSend}:${total}`, {
          disable_notification: true,
        })
        .catch((err) => {
          console.log(err)
        })
    }
  }
}
