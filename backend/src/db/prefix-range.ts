// Prefix searches as an index range (vendor names, PO numbers): every value that starts
// with p sorts at or above p and below p || chr(MAX_CODE_POINT), so a B-tree index answers
// them without LIKE.

/**
 * The highest code point (U+10FFFF, a noncharacter): every value that starts with `p` sorts
 * below `p || chr(MAX_CODE_POINT)`, unless that very character follows the prefix.
 */
export const MAX_CODE_POINT = 1_114_111;
