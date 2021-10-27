import { exec, spawn } from 'child_process'
import { writeFile } from 'fs'
import { Context } from 'telegraf'
const fs = require('fs')
const needle = require('needle')
const queue = require('queue')
const q = queue({ concurrency: 5, autostart: true })
q.start()

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
  let msg = await ctx.reply('Task added to queue...')
  q.push(async (cb) => {
    try { ctx.deleteMessage(msg.message_id) } catch (e) { }
    ctx.reply('Started execution...')
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
        ctx.replyWithChatAction('typing')
        console.log(`Starting painting for ${usr_dir}`)
        const pythonProcess2 = spawn('python3',
          ["./lama/bin/predict.py",
            `model.path=${process.cwd()}/lama/big-lama`,
            `indir=${process.cwd()}/${usr_dir.substring(1)}/out`,
            `outdir=${process.cwd()}/${usr_dir.substring(1)}/out`,
            `dataset.img_suffix=.jpg`])

        // pythonProcess2.stdout.on('data', async (data) => {
        //   console.log(`stdout2: ${data}`);
        //   await ctx.replyWithChatAction('typing')
        // });
        pythonProcess2.stderr.on('data', (data) => {
          console.error(`stderr2: ${data}`);
        });

        pythonProcess2.on('close', async (code) => {
          console.log(`Finished painting for ${usr_dir} with code ${code}`)
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
            ctx.reply('Error during painting, try again later', { reply_to_message_id: ctx.message.message_id })
            await delete_task_user(ctx)
            cb()
          }
        })
      } else {
        ctx.reply('Error during painting, try again later', { reply_to_message_id: ctx.message.message_id })
        await delete_task_user(ctx)
        cb()
      }
    })
  })
}

export async function processPhoto(ctx: Context) {
  if (ctx.dbuser.jobs.length >= 1) {
    ctx.reply('Wait until previous task is finished!')
    return
  }

  let file = await get_file(ctx)
  if (file) {
    if ('document' in ctx.message && ctx.dbuser.id != 180001222) {
      ctx.reply('Files are unsupported now. Stay tuned!')
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
      if (ctx.dbuser.jobs.length < 1) {
        let user = ctx.dbuser
        user.jobs.unshift(Date.now())
        user = await (user as any).save()
        ctx.dbuser.save()

        var out_dir = usr_dir + '/out'
        if (!fs.existsSync(out_dir)) {
          fs.mkdirSync(out_dir);
        }
        ctx.replyWithChatAction('typing')
        console.log(`Starting mask extraction for ${usr_dir}`)

        await process_image(ctx, usr_dir)
      }
    } else {
      ctx.reply('Original image saved. Now draw what you want to remove and send the result as a reply', { reply_to_message_id: ctx.message.message_id })
    }
  }
}