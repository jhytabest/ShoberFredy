/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { decideListing } from '../jobs/jobDecisionService.js';
import * as telegram from '../../notification/adapter/telegram.js';
import { formatListing } from '../../utils/formatListing.js';
import { listingFactsGerman } from '../../notification/listingLabels.js';
import { getPipelineConfig } from '../storage/pipelineConfigStorage.js';
import { notificationSettled } from './terminalVerdict.js';
import { env } from '../../shared/env.js';
import { registerHandler,startWorker } from './workQueue.js';
import { destinations,deliveriesForKeys,recordDeliveryReceipt,markDeliveriesCancelled,markDeliveriesFailed,markDeliveriesSent } from './notificationOutbox.js';

export function startNotificationDispatcher() {
  registerHandler('notify', {
    name:'notify',enabled:()=>env('FREDY_NOTIFICATION_ENABLED'),timeoutMs:()=>env('FREDY_NOTIFICATION_ITEM_TIMEOUT_MS'),
    maxAttempts:()=>env('FREDY_NOTIFY_MAX_FAILURES'),startedMessage:'Shared notification dispatcher started.',
    handler:(item,{signal})=>dispatchDelivery(item,signal),
  });
  return startWorker('notify');
}
async function dispatchDelivery(item,signal) {
  const [row] = deliveriesForKeys([item.key]);
  if (!row) { markDeliveriesCancelled([item.key],'Listing missing'); return; }
  const db = SqliteConnection.getConnection();
  const config = getPipelineConfig(db);
  if (notificationSettled(db,row.id,row.chat_id,row.topic_id)) { markDeliveriesSent([item.key]); return; }
  if (!destinations(config.notify).some((d)=>d.chatId===row.chat_id && d.topicId===row.topic_id)) {
    markDeliveriesCancelled([item.key],'Destination removed','adapter_removed'); return;
  }
  if (!decideListing(db,row,config).accepted) { markDeliveriesCancelled([item.key],'Listing rejected by shared policy'); return; }
  const listing = { ...formatListing(row), image:row.image_url, imagePath:row.stored_image_path,
    facts:listingFactsGerman(row), summary:row.summary, comments:row.comments };
  try {
    await telegram.send({serviceName:row.provider,newListings:[listing],signal,
      adapter:{fields:{token:config.notify.token,chatId:row.chat_id,messageThreadId:row.topic_id||null,plainText:config.notify.plainText}},
      onReceipt:(_chat,response)=>recordDeliveryReceipt(item.key,row,response),
    });
    markDeliveriesSent([item.key]);
  } catch(error) {
    if (signal?.aborted) throw error;
    markDeliveriesFailed([item.key],error);
  }
}
