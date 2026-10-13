/*
  Warnings:

  - Changed the type of `relation` on the `UserChildRelation` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
/*
  ⚠ 本文件在 Prisma 生成结果上**手工改过一处**，改动本身是这一步的一部分：

  Prisma 生成的原文是
      ALTER TABLE "UserChildRelation" DROP COLUMN "relation",
      ADD COLUMN     "relation" "RelationKind" NOT NULL;
  它自带的警告写着「No cast exists, the column would be dropped and recreated,
  which cannot be done if there is data」—— 也就是说：**只要表里有数据，这一列就被清空**，
  而且不会报错（本机此刻 0 行，所以"看起来没事"）。

  改为 `ALTER COLUMN ... TYPE ... USING`：
    ① 保留既有取值；
    ② 若库里存在不在枚举里的值（手工改过数据），迁移**当场失败**而不是把该列抹掉 ——
       fail-closed：宁可迁移不过，也不要静默丢数据。

  这一条与 `tools/relation-kind-check.mjs` 的检查 ③ 对应（迁移必须用 USING，不许 DROP+ADD）。
*/

-- CreateEnum
CREATE TYPE "RelationKind" AS ENUM ('father', 'mother', 'grandparent', 'other');

-- AlterTable（保数据转型：不使用 Prisma 默认的 DROP + ADD）
ALTER TABLE "UserChildRelation"
  ALTER COLUMN "relation" TYPE "RelationKind"
  USING "relation"::"RelationKind";

