本目录**故意保持为空**（只有这个说明文件，没有 `*.test.ts`）。

用途：`scripts/test-can-fail.mjs` 的检查项 B —— 把测试入口 `scripts/run-tests.mjs` 指向本目录
（`KP_TEST_DIR=scripts/__fixtures__/empty-test-dir`），证明「**0 个用例**」会被判红。

为什么需要它（实测，Node v26.10.0，2026-10-14）：把 `node --import tsx --test <目录>` 指向一个
空目录，输出是 `ℹ tests 0` 而**退出码是 0** —— 也就是说「一个用例都没跑」看起来是绿的。
这与 D12（测试器花括号嵌套错位导致 CI 永久假绿）是同一类病：**「通过」这个信号自身没有被测过**。
