import { prop, getModelForClass } from '@typegoose/typegoose'

export class User {
  @prop({ required: true, index: true, unique: true })
  id: number

  @prop({ required: true, default: 'en' })
  language: string
  
  @prop({ required: true, default: 0 })
  jobs: number
}

// Get User model
const UserModel = getModelForClass(User, {
  schemaOptions: { timestamps: true },
})

// Get or create user
export async function findUser(id: number) {
  let user = await UserModel.findOne({ id })
  if (!user) {
    // Try/catch is used to avoid race conditions
    try {
      user = await new UserModel({ id }).save()
    } catch (err) {
      user = await UserModel.findOne({ id })
    }
  }
  return user
}

export async function emptyLimits() {
  await UserModel.updateMany({}, {"$set":{"jobs": 0}})
}

export async function countUsers() {
  return await UserModel.countDocuments({})
}