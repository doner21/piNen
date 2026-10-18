// Shared kernel inventory validation. Only Windows' legitimate PID0 row is
// excluded; one malformed positive generation invalidates the entire sample.
'use strict';
const validProcessGeneration=v=>Boolean(v&&Number.isSafeInteger(v.pid)&&v.pid>0&&Number.isSafeInteger(v.parentPid)&&typeof v.born==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(v.born)&&Number.isFinite(Date.parse(v.born)));
function processInventoryRows(value){
 if(!Array.isArray(value))return undefined;
 const rows=value.filter(row=>row?.pid!==0);
 return rows.every(validProcessGeneration)?rows.map(row=>({...row})):undefined;
}
module.exports={validProcessGeneration,processInventoryRows};
