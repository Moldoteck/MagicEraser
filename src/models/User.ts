import { getModelForClass, modelOptions, prop } from '@typegoose/typegoose'

export type DateMap = { [key: string]: Date }
@modelOptions({ schemaOptions: { timestamps: true } })
export class User {
  @prop({ required: true, index: true, unique: true })
  id!: number
  @prop({ required: true, default: 'en' })
  language!: string
  @prop({ required: false, default: 0 })
  jobs!: number
  @prop({ required: false, default: '' })
  originalPhoto!: string

  @prop({ required: false, default: [] })
  oldPhotos!: DateMap[]
}

//type where key is string and value is date

const UserModel = getModelForClass(User)

export function findOrCreateUser(id: number) {
  return UserModel.findOneAndUpdate(
    { id },
    {},
    {
      upsert: true,
      new: true,
    }
  )
}
//delete user
export function deleteUser(id: number) {
  return UserModel.findOneAndDelete({ id })
}

export async function countUsers() {
  return await UserModel.countDocuments({})
}

export async function findAllUsers() {
  return await UserModel.find({})
}
