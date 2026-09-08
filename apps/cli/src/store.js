import { getAddress } from 'viem';
import { query, tx, audit } from '@retainer/db';
import { config, decodeExtraData } from '@retainer/chain';

/**
 * Persist a signed permission. This row IS the consent audit record: the exact
 * struct the user signed, their signature, and when. Nothing here is mutated
 * afterwards except registration and revocation bookkeeping.
 */
export async function storePermission(p) {
  const { executor, recipient } = decodeExtraData(p.extraData);
  const { rows } = await query(
    `INSERT INTO permissions
      (permission_hash, account, spender, token, allowance, period_seconds, start_ts, end_ts,
       salt, extra_data, executor, recipient, chain_id, signature, approved_tx_hash, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (permission_hash) DO UPDATE SET
       approved_tx_hash = COALESCE(permissions.approved_tx_hash, EXCLUDED.approved_tx_hash),
       approved_at      = COALESCE(permissions.approved_at, EXCLUDED.approved_at)
     RETURNING id`,
    [p.permissionHash, getAddress(p.account), getAddress(p.spender), getAddress(p.token),
     p.allowance.toString(), p.period, p.start, p.end, p.salt.toString(), p.extraData,
     getAddress(executor), getAddress(recipient), config().chainId, p.signature,
     p.approvedTxHash ?? null, p.approvedTxHash ? new Date() : null]);

  const id = rows[0].id;
  await tx(async (c) => audit(c, {
    actor: 'user', event: 'permission.signed', permissionId: id, txHash: p.approvedTxHash ?? null,
    detail: {
      permissionHash: p.permissionHash, account: p.account, spender: p.spender, token: p.token,
      allowance: p.allowance.toString(), periodSeconds: p.period, start: p.start, end: p.end,
      salt: p.salt.toString(), extraData: p.extraData, signature: p.signature,
    },
  }));
  return id;
}

export async function markRevoked(permissionHash, txHash) {
  const { rows } = await query(
    `UPDATE permissions SET revoked_at = now(), revoked_tx_hash = $2
      WHERE permission_hash = $1 RETURNING id`, [permissionHash, txHash]);
  if (rows.length) {
    await tx(async (c) => audit(c, {
      actor: 'user', event: 'permission.revoked', permissionId: rows[0].id, txHash,
      detail: { permissionHash },
    }));
  }
  return rows[0]?.id ?? null;
}
