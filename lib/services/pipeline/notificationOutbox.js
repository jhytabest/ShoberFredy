/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from '../storage/SqliteConnection.js';
import { listingAttributes } from '../listings/attributes.js';
import { getPipelineConfig } from '../storage/pipelineConfigStorage.js';
import { notificationSettled } from './terminalVerdict.js';
import { completeWork, enqueueWork, cancelWork, retryWork } from './workQueue.js';
import { env } from '../../shared/env.js';

export function destinations(notify) {
  const topicId = Number(notify.threadId) || 0;
  return [...new Set(String(notify.chatId).split(',').map((s) => BigInt(s.trim()).toString()))].map((chatId) => ({ chatId, topicId }));
}
export function enqueueNotification(listingId, config = getPipelineConfig()) {
  if (!config.notify?.token || !config.notify?.chatId) return;
  const db = SqliteConnection.getConnection();
  for (const { chatId, topicId } of destinations(config.notify)) {
    if (notificationSettled(db, listingId, chatId, topicId)) continue;
    const key = JSON.stringify([listingId, chatId, topicId]);
    const previous = db.prepare(`SELECT status,outcome_code FROM pipeline_work WHERE kind='notify' AND key=?`).get(key);
    enqueueWork('notify', key, { listingId, chatId, topicId }, {
      mode: previous?.status === 'cancelled' && ['listing_hidden','adapter_removed'].includes(previous.outcome_code) ? 'reset' : 'ignore',
    });
  }
}
export function deliveriesForKeys(keys) {
  return SqliteConnection.getConnection().prepare(`SELECT l.*,w.key AS delivery_key,
    json_extract(w.payload_json,'$.chatId') AS chat_id,json_extract(w.payload_json,'$.topicId') AS topic_id,
    a.data AS attributes_json,
    (SELECT storage_path FROM listing_images i WHERE i.queue_id=l.representative_queue_id AND i.download_status='stored' ORDER BY position LIMIT 1) AS stored_image_path
    FROM pipeline_work w JOIN listings l ON l.id=json_extract(w.payload_json,'$.listingId')
    LEFT JOIN listing_attributes a ON a.listing_id=l.id WHERE w.kind='notify' AND w.key IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(keys)).map((row) => ({ ...row, ...listingAttributes(row) }));
}
export function recordDeliveryReceipt(key, row, response) {
  const receipt = response?.result;
  if (!Number.isInteger(receipt?.message_id) || receipt.chat?.id == null) throw new Error('Telegram returned no message receipt');
  SqliteConnection.withTransaction((db) => {
    db.prepare(`INSERT OR IGNORE INTO notification_receipts (delivery_key,listing_id,chat_id,topic_id,message_id,received_at)
      VALUES (?,?,?,?,?,?)`).run(key,row.id,String(receipt.chat.id),row.topic_id,receipt.message_id,Date.now());
    db.prepare(`INSERT INTO pipeline_audit_events (listing_id,queue_id,stage,action,payload_json,created_at) VALUES (?,?,'notification','receipt',?,?)`)
      .run(row.id,key,JSON.stringify({ chatId: String(receipt.chat.id), topicId: row.topic_id, messageId: receipt.message_id }),Date.now());
  });
}
export function markDeliveriesSent(keys) { for (const key of keys) completeWork('notify',key,{ status:'sent',action:'sent',code:'delivered' }); }
export function markDeliveriesCancelled(keys,reason,code='listing_hidden') { for (const key of keys) cancelWork('notify',key,reason,{code}); }
export function markDeliveriesFailed(keys,error) { for (const key of keys) retryWork('notify',key,error,{stage:'notification',maxFailures:env('FREDY_NOTIFY_MAX_FAILURES')}); }
