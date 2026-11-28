// Turns the portals' table and RPC requests into parameterised SQL.
//
// Every identifier is validated and quoted, every value travels as a bind
// parameter, and results are serialised to JSON by Postgres itself so dates,
// numerics and bigints reach the browser in the same form as before.
// Authorisation is not decided here: the statement runs as the caller's
// database role, so grants and row-level-security policies apply.
import { ApiError } from './errors.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_ROWS = 10000;
const COMPARISON = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

export function ident(name, what = 'identifier') {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new ApiError(400, 'PGRST100', `Invalid ${what} name.`);
  }
  return `"${name}"`;
}

const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function columnList(columns) {
  if (columns === undefined || columns === null || columns === '' || columns === '*') return '_t.*';
  const names = Array.isArray(columns) ? columns : String(columns).split(',');
  return names.map(name => {
    const trimmed = String(name).trim();
    return trimmed === '*' ? '_t.*' : `_t.${ident(trimmed, 'column')}`;
  }).join(', ');
}

function whereClause(filters, params) {
  if (filters === undefined || filters === null) return '';
  if (!Array.isArray(filters)) throw new ApiError(400, 'PGRST100', 'Filters must be a list.');
  const push = value => {
    if (!isScalar(value)) throw new ApiError(400, 'PGRST100', 'Filter values must be text, numbers, booleans or null.');
    params.push(value);
    return `$${params.length}`;
  };
  const parts = filters.map(filter => {
    const column = `_t.${ident(filter?.column, 'column')}`;
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value)) throw new ApiError(400, 'PGRST100', 'An "in" filter needs a list of values.');
      if (!filter.value.length) return 'false';
      return `${column} IN (${filter.value.map(push).join(', ')})`;
    }
    if (filter.op === 'is') {
      if (filter.value === null) return `${column} IS NULL`;
      if (filter.value === true) return `${column} IS TRUE`;
      if (filter.value === false) return `${column} IS FALSE`;
      throw new ApiError(400, 'PGRST100', 'An "is" filter accepts only null, true or false.');
    }
    const operator = COMPARISON[filter.op];
    if (!operator) throw new ApiError(400, 'PGRST100', 'Unsupported filter operator.');
    return `${column} ${operator} ${push(filter.value)}`;
  });
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

function orderClause(order) {
  if (!order?.length) return '';
  if (!Array.isArray(order)) throw new ApiError(400, 'PGRST100', 'Order must be a list.');
  const parts = order.map(item => {
    let sql = `_t.${ident(item?.column, 'column')} ${item.ascending === false ? 'DESC' : 'ASC'}`;
    if (item.nullsFirst === true) sql += ' NULLS FIRST';
    else if (item.nullsFirst === false) sql += ' NULLS LAST';
    return sql;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

function limitClause(limit) {
  if (limit === undefined || limit === null) return ` LIMIT ${MAX_ROWS}`;
  if (!Number.isInteger(limit) || limit < 0) throw new ApiError(400, 'PGRST100', 'Limit must be a whole number.');
  return ` LIMIT ${Math.min(limit, MAX_ROWS)}`;
}

function payloadRows(values) {
  const rows = Array.isArray(values) ? values : [values];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ApiError(400, 'PGRST102', 'Rows must be JSON objects.');
    }
  }
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (rows.length && !columns.length) throw new ApiError(400, 'PGRST102', 'Rows must set at least one column.');
  return { rows, columns, quoted: columns.map(column => ident(column, 'column')) };
}

const asJsonRows = inner =>
  `SELECT coalesce(json_agg(row_to_json(_q)), '[]'::json)::text AS body FROM (${inner}) _q`;

// A write returns its rows only when the page asked for them, so a role that
// may insert but not read (a student posting an update) is not refused.
function finishWrite(statement, returning) {
  if (returning === undefined || returning === null || returning === false) return { sql: statement, hasBody: false };
  return {
    sql: `WITH _q AS (${statement} RETURNING ${columnList(returning === true ? '*' : returning)}) ` +
      `SELECT coalesce(json_agg(row_to_json(_q)), '[]'::json)::text AS body FROM _q`,
    hasBody: true,
  };
}

// Request: { table, action, columns?, filters?, order?, limit?, values?, onConflict?, ignoreDuplicates?, returning? }
// Returns { sql, params, hasBody } or { empty: true } when there is nothing to run.
export function buildTableQuery(request) {
  if (!request || typeof request !== 'object') throw new ApiError(400, 'PGRST100', 'Invalid request.');
  const table = `public.${ident(request.table, 'table')}`;
  const params = [];

  switch (request.action) {
    case 'select': {
      const sql = `SELECT ${columnList(request.columns)} FROM ${table} AS _t` +
        whereClause(request.filters, params) + orderClause(request.order) + limitClause(request.limit);
      return { sql: asJsonRows(sql), params, hasBody: true };
    }

    case 'insert':
    case 'upsert': {
      const { rows, columns, quoted } = payloadRows(request.values);
      if (!rows.length) return { empty: true, hasBody: Boolean(request.returning) };
      params.push(JSON.stringify(rows));
      let sql = `INSERT INTO ${table} AS _t (${quoted.join(', ')}) ` +
        `SELECT ${quoted.map(column => `_v.${column}`).join(', ')} ` +
        `FROM jsonb_populate_recordset(null::${table}, $1::text::jsonb) AS _v`;
      if (request.action === 'upsert') {
        const conflict = String(request.onConflict || '').split(',').map(name => name.trim()).filter(Boolean);
        if (!conflict.length) throw new ApiError(400, 'PGRST100', 'An upsert must name its conflict columns (onConflict).');
        const updates = columns.filter(column => !conflict.includes(column));
        sql += ` ON CONFLICT (${conflict.map(column => ident(column, 'column')).join(', ')}) `;
        sql += request.ignoreDuplicates || !updates.length
          ? 'DO NOTHING'
          : `DO UPDATE SET ${updates.map(column => `${ident(column)} = EXCLUDED.${ident(column)}`).join(', ')}`;
      }
      return { ...finishWrite(sql, request.returning), params };
    }

    case 'update': {
      const values = request.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new ApiError(400, 'PGRST102', 'An update needs an object of new values.');
      }
      const { quoted } = payloadRows(values);
      params.push(JSON.stringify(values));
      const where = whereClause(request.filters, params);
      if (!where) throw new ApiError(400, '21000', 'UPDATE requires a WHERE clause');
      const sql = `UPDATE ${table} AS _t SET ${quoted.map(column => `${column} = _v.${column}`).join(', ')} ` +
        `FROM (SELECT * FROM jsonb_populate_record(null::${table}, $1::text::jsonb)) AS _v` + where;
      return { ...finishWrite(sql, request.returning), params };
    }

    case 'delete': {
      const where = whereClause(request.filters, params);
      if (!where) throw new ApiError(400, '21000', 'DELETE requires a WHERE clause');
      return { ...finishWrite(`DELETE FROM ${table} AS _t` + where, request.returning), params };
    }

    default:
      throw new ApiError(400, 'PGRST100', 'Unsupported action.');
  }
}

// Looks up how to call public.<name>. Run with the server's own privileges and
// cached; the call itself runs as the caller's role.
export const FUNCTION_LOOKUP_SQL = `
  select array_to_string(coalesce(p.proargnames, '{}'::text[]), '|') as arg_names,
         array_to_string(array(
           select format_type(t.oid, null)
           from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as t(oid, position)
           order by t.position), '|') as arg_types,
         array_to_string(coalesce(p.proargmodes::text[], '{}'::text[]), '') as arg_modes,
         p.proretset as returns_set,
         p.prorettype = 'void'::regtype as returns_void
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = $1 and p.prokind = 'f'
  order by p.oid`;

export function describeFunctions(rows) {
  return rows.map(row => {
    const names = row.arg_names ? row.arg_names.split('|') : [];
    const types = row.arg_types ? row.arg_types.split('|') : [];
    const modes = row.arg_modes || '';
    const inputs = new Map();
    names.forEach((name, index) => {
      const mode = modes[index] || 'i';
      if (name && (mode === 'i' || mode === 'b' || mode === 'v')) inputs.set(name, types[index]);
    });
    return { inputs, returnsSet: row.returns_set === true, returnsVoid: row.returns_void === true };
  });
}

export function buildRpcQuery(name, args, overloads) {
  const fn = `public.${ident(name, 'function')}`;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ApiError(400, 'PGRST102', 'Function arguments must be a JSON object.');
  const supplied = Object.keys(args);
  const target = overloads.find(candidate => supplied.every(arg => candidate.inputs.has(arg)));
  if (!target) {
    throw new ApiError(404, 'PGRST202', `Could not find the function public.${name}(${supplied.join(', ')}) in the schema cache`);
  }

  const params = [];
  let from = `${fn}() AS _r`;
  if (supplied.length) {
    params.push(JSON.stringify(args));
    const definition = supplied.map(arg => `${ident(arg, 'argument')} ${target.inputs.get(arg)}`).join(', ');
    const call = supplied.map(arg => `${ident(arg, 'argument')} => _a.${ident(arg, 'argument')}`).join(', ');
    from = `jsonb_to_record($1::text::jsonb) AS _a(${definition}), LATERAL ${fn}(${call}) AS _r`;
  }

  // "_r" is the result column for a scalar function and the whole row for a
  // composite or table function, so to_json() gives the right shape for both.
  let select = 'to_json(_r)::text';
  if (target.returnsSet) select = `coalesce(json_agg(_r), '[]'::json)::text`;
  else if (target.returnsVoid) select = `'null'`;
  return { sql: `SELECT ${select} AS body FROM ${from}`, params };
}
