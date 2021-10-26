import I18N from 'telegraf-i18n'
import { Chat, User } from '@/models'
import { DocumentType } from '@typegoose/typegoose'

declare module 'telegraf' {
  export class Context {
    dbuser: DocumentType<User>
    dbchat: DocumentType<Chat>
    i18n: I18N
  }
}
