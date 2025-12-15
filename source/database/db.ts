import { connectDatabase } from "./config";
import AdminModel from "./models/admin.model";
import { Bonus } from "./models/bonus.model";
import { MassDM } from "./models/massdm.model";
import { DMNotification } from "./models/notification.model";
import { PromoCodeHistory } from "./models/promocodehistory.model";
import { RefCode } from "./models/refcode.model";
import UserModel from "./models/user.model";
import volumebotModel from "./models/volumebot.model";

export const getPromotionCode = async() => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      resolve(record?.promo_code);
    });
  });
}

export const setPromotionCode = async(promo_code:string) => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      if (!record) {
        record = new AdminModel();
      }

      record.promo_code = promo_code;
      await record.save();

      resolve(record);
    });
  });
}


export const isUsedPromotionCode = async(chat_id:string, code:string) => {
  return new Promise(async (resolve, reject) => {
    const record = await PromoCodeHistory.findOne({ chat_id: chat_id, promo_code: code });
    resolve(record != null);
  });
}

export const setClaimedPromotionCode = async(chat_id:string, code:string) => {
  return new Promise(async (resolve, reject) => {
    await PromoCodeHistory.create({
      chat_id: chat_id,
      promo_code: code,
      claimed_at: new Date(),
    });

    resolve(true);
  });
}

export const getPromotionText = async() => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      resolve(record?.promo_text);
    });
  });
}

export const setPromotionText = async(promo_text:string) => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      if (!record) {
        record = new AdminModel();
      }

      record.promo_text = promo_text;
      await record.save();

      resolve(record);
    });
  });
}
  
export const addMassDM = async(message:string, fileId:string="", message_type = 1) => {
  return new Promise(async (resolve, reject) => {
    try {
      MassDM.create({
        message: message,
        file_id: fileId,
        message_type: message_type,
      }).then((record) => {
        resolve(record);
      });
    } catch (error) {
      reject(error);
      resolve(null);
    }
  });
}


export const insertNotifications = async(notifications:any) => {
  return new Promise(async (resolve, reject) => {
    for (let i=0; i<notifications.length; i++) {
      const record = await new DMNotification({
        chat_id: notifications[i].chat_id,
        message: notifications[i].message,
        file_link: notifications[i].file_link,
        message_type: notifications[i].message_type,
      }).save();
    }
  });
}

export const cleanupOldNotifications = async(cutoffDate:any) => {
  return new Promise(async (resolve, reject) => {
    try {
      const result = await DMNotification.deleteMany({
        status: 'completed',
        processedAt: { $lt: cutoffDate }
      });

      resolve(result);
    } catch (error) {
      reject(error);
      resolve(null);
    }
  });
}

export const getTotalUserCount = async() => {
  return new Promise(async (resolve, reject) => {
    // const count = await volumebotModel.countDocuments();
    const count = await UserModel.countDocuments();
    resolve(count);
  });
}

export const getUsers = async(page:number, limit:number) => {
  return new Promise(async (resolve, reject) => {
    // const records = await volumebotModel.find().skip((page-1) * limit).limit(limit);
    const records = await UserModel.find().skip((page-1) * limit).limit(limit);
    resolve(records);
  });
}

export const addBonus = async(chat_id:string, amount:number) => {
  return new Promise(async (resolve, reject) => {
    let bonus = await Bonus.findOne({ chat_id: chat_id});
    if (!bonus) {
      await Bonus.create({
        chat_id: chat_id,
        amount: amount,
      });
    } else {
      bonus.amount += amount;
      await bonus.save();
    }

    resolve(true);
  });
}

export const useBonus = async(chat_id:string) => {
  return new Promise(async (resolve, reject) => {
    const bonus = await Bonus.findOneAndDelete({ chat_id: chat_id});
    resolve(bonus);
  });
}

export const getBonus = async(chat_id:string) => {
  return new Promise(async (resolve, reject) => {
    const bonus = await Bonus.findOne({ chat_id: chat_id});
    resolve(bonus);
  });
}

export const setMaxBuy = async(userId: string, max_buy:number) => {
    return new Promise(async (resolve, reject) => {
        await volumebotModel.findOneAndUpdate({ userId: userId }, { maxBuy: max_buy });

        resolve(true);
    });
}

export const setDelay = async(userId: string, delay:number) => {
    return new Promise(async (resolve, reject) => {
        await volumebotModel.findOneAndUpdate({ userId: userId }, { delayTime: delay });

        resolve(true);
    });
}

export const setWorkingTime = async(userId: string, workingTime:number) => {
    return new Promise(async (resolve, reject) => {
        await volumebotModel.findOneAndUpdate({ userId: userId }, { workingTime: workingTime });

        resolve(true);
    });
}

export const getOneKVolPrice = async() => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      resolve(record?.one_k_vol_price);
    });
  });
}

export const getTaxRate = async() => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      resolve(record?.tax_rate);
    });
  });
}

export const getTaxEnabled = async() => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      resolve(record?.tax_enabled);
    });
  }
  );
}

export const setTaxEnabled = async(enabled:boolean) => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      if (!record) {
        record = new AdminModel();
      }

      record.tax_enabled = enabled;
      await record.save();

      resolve(record);
    });
  });
}

export const setOneKVolPrice = async(price:number) => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      if (!record) {
        record = new AdminModel();
      }

      record.one_k_vol_price = price;
      await record.save();

      resolve(record);
    });
  });
}


export const setTaxRate = async(rate:number) => {
  return new Promise(async (resolve, reject) => {
    AdminModel.findOne().then(async (record) => {
      if (!record) {
        record = new AdminModel();
      }

      record.tax_rate = rate;
      await record.save();

      resolve(record);
    });
  });
}

const generateCode = () => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const codeLength = 5;
  let getOneTimeCode = '';

  for (let i = 0; i < codeLength; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    getOneTimeCode += characters[randomIndex];
  }

  return getOneTimeCode;
}

// generate unique refcode
export const generateNewRefCode = async () => {
  // create new one-time code for the user
  let newCode, dupOk = false;

  do {
    newCode = generateCode();
    // console.log("Generated code:", newCode);

    // find on db to check uniquity
    const res = await RefCode.findOne({
      code : newCode
    });

    if (res == null) dupOk = true;
  } while (!dupOk);

  return newCode;
};

export const getOneTimeCodes = async(chatid: number) => {
  return new Promise(async (resolve, reject) => {
    RefCode.find({chat_id: chatid, used: false}).limit(100).then(async (one_time_codes) => {
      resolve(one_time_codes);
    });
  });
};

export const getRefCode = async(code: string) => {
  return new Promise(async (resolve, reject) => {
    RefCode.findOne({code: code}).then(async (refCode) => {
      resolve(refCode);
    });
  });
}

export const isValidRefCode = async(code:string) => {
  return new Promise(async (resolve, reject) => {
    const refcode = await RefCode.findOne({
      code : code, 
      used : false,
    });
    
    console.log("[isValidRefCode]", refcode);
    resolve(refcode != undefined && refcode != null);
  });
}

export const updateRefCode = async(code:string, chatid:string) => {
  return new Promise(async (resolve, reject) => {
    const refCode = await RefCode.findOne({
      code
    });

    if (refCode && !refCode.used) {
      console.log("update!!!");
      // update db to flag as used
      const filter = { code: code };
      const update = { used: "true", used_at: new Date(), used_by: chatid };

      let user = await RefCode.findOneAndUpdate(filter, update);

      // // generate new one-time code and finally insert into db
      // let newCode = await generateNewRefCode();

      // let result = await RefCode.create({
      //   code: newCode, 
      //   chat_id:user?.chat_id, 
      //   used:false,
      // })

      resolve(true);
    }
    resolve(false);
  });
}

export const getValidRefCodeRandomly = async() => {
  return new Promise(async (resolve, reject) => {
    const refCode = await RefCode.findOne({
      used: false,
    });

    resolve(refCode);
  });
}

export const generateBulkRefCode = async(chat_id:string, count:number) => {
  if (count< 1) return;

  for( let i=0; i<count;i++) {
    let newCode = await generateNewRefCode();

    await RefCode.create({
      code: newCode, 
      chat_id: chat_id, 
      used: false,
    });
  }
}

export const updateUser = (params: any) => {
  return new Promise(async (resolve, reject) => {
    UserModel.findOne({ chatid: params.chatid }).then(async (user: any) => {
      if (!user) {
        user = new UserModel();
        user.depositWallet = params.depositWallet;
      }
      user.chatid = params.chatid;
      user.username = params.username ?? '';
      user.referredBy = params.referredBy;
      user.referredTimestamp = params.referredTimestamp;
      // user.dexId = params.dexId;
      // user.poolType = params.poolType;
      // user.pairAddress = params.pairAddress;
      await user.save();
      resolve(user);
    });
  });
};

export const updateGatherDate = (params: any) => {
  return new Promise(async (resolve, reject) => {
    UserModel.findOne({ chatid: params.chatid }).then(async (user: any) => {
      user.gatherDate = new Date().getTime();
      await user.save();
      resolve(user);
    });
  });
};


export const removeUser = (params: any) => {
  return new Promise((resolve, reject) => {
    UserModel.deleteOne({ chatid: params.chatid }).then(() => {
      resolve(true);
    });
  });
};

export async function selectUsers(params: any = {}) {
  return new Promise(async (resolve, reject) => {
    UserModel.find(params).then(async (users) => {
      resolve(users);
    });
  });
}

export async function countUsers(params: any = {}) {
  return new Promise(async (resolve, reject) => {
    UserModel.countDocuments(params).then(async (users) => {
      resolve(users);
    });
  });
}

export async function selectUser(params: any) {
  return new Promise(async (resolve, reject) => {
    UserModel.findOne(params).then(async (user) => {
      resolve(user);
    });
  });
}

export async function deleteUser(params: any) {
  return new Promise(async (resolve, reject) => {
    UserModel.deleteOne(params).then(async (user) => {
      resolve(user);
    });
  });
}