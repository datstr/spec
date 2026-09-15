# Generates tools/blake2b-mine.wat; assemble with wabt (npm i wabt; wat2wasm) into gateway/miner-mine.wasm.
# Emits WAT: BLAKE2b-256 of the 80-byte work header at memory 0, with the nonce loop inside.
IV=[0x6a09e667f3bcc908,0xbb67ae8584caa73b,0x3c6ef372fe94f82b,0xa54ff53a5f1d36f1,0x510e527fade682d1,0x9b05688c2b3e6c1f,0x1f83d9abfb41bd6b,0x5be0cd19137e2179]
SIGMA=[[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],[11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],[7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],[9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],[12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],[6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],[10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0],[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3]]
H0=[IV[0]^0x01010020]+IV[1:]
def s64(x): return x-(1<<64) if x>=(1<<63) else x
out=[]; w=out.append
w('(module')
w('  (memory (export "memory") 1)')
w('  ;; 0..80 work header (nonce at 32..36) | 128..160 target, big-endian bytes | 256..288 digest | 512 nonce found (i32) | 516 found flag (i32)')
w('  (func $mine (export "mine") (param $start i32) (param $step i32) (param $count i32) (result i32)')
w('    (local $i i32) (local $n i32) (local $j i32)')
for k in range(16): w(f'    (local $m{k} i64)')
for k in range(16): w(f'    (local $v{k} i64)')
w('    (i32.store (i32.const 516) (i32.const 0))')
for k in range(10): w(f'    (local.set $m{k} (i64.load offset={k*8} (i32.const 0)))')
for k in range(10,16): w(f'    (local.set $m{k} (i64.const 0))')
w('    (local.set $n (local.get $start))')
w('    (block $done (loop $next')
w('      ;; the nonce is the low 32 bits of message word 4')
w('      (local.set $m4 (i64.or (i64.and (local.get $m4) (i64.const -4294967296)) (i64.extend_i32_u (local.get $n))))')
for k in range(8): w(f'      (local.set $v{k} (i64.const {s64(H0[k])}))')
for k in range(8): 
    val=IV[k]
    if k==4: val^=80
    if k==6: val^=0xffffffffffffffff
    w(f'      (local.set $v{k+8} (i64.const {s64(val)}))')
def G(a,b,c,d,x,y):
    w(f'      (local.set $v{a} (i64.add (i64.add (local.get $v{a}) (local.get $v{b})) (local.get $m{x})))')
    w(f'      (local.set $v{d} (i64.rotr (i64.xor (local.get $v{d}) (local.get $v{a})) (i64.const 32)))')
    w(f'      (local.set $v{c} (i64.add (local.get $v{c}) (local.get $v{d})))')
    w(f'      (local.set $v{b} (i64.rotr (i64.xor (local.get $v{b}) (local.get $v{c})) (i64.const 24)))')
    w(f'      (local.set $v{a} (i64.add (i64.add (local.get $v{a}) (local.get $v{b})) (local.get $m{y})))')
    w(f'      (local.set $v{d} (i64.rotr (i64.xor (local.get $v{d}) (local.get $v{a})) (i64.const 16)))')
    w(f'      (local.set $v{c} (i64.add (local.get $v{c}) (local.get $v{d})))')
    w(f'      (local.set $v{b} (i64.rotr (i64.xor (local.get $v{b}) (local.get $v{c})) (i64.const 63)))')
for r in range(12):
    s=SIGMA[r]
    G(0,4,8,12,s[0],s[1]); G(1,5,9,13,s[2],s[3]); G(2,6,10,14,s[4],s[5]); G(3,7,11,15,s[6],s[7])
    G(0,5,10,15,s[8],s[9]); G(1,6,11,12,s[10],s[11]); G(2,7,8,13,s[12],s[13]); G(3,4,9,14,s[14],s[15])
for k in range(4): w(f'      (i64.store offset={256+k*8} (i32.const 0) (i64.xor (i64.xor (i64.const {s64(H0[k])}) (local.get $v{k})) (local.get $v{k+8})))')
w('      ;; digest <= target, byte by byte from the first (big-endian)')
w('      (local.set $j (i32.const 0))')
w('      (block $cmp (loop $c')
w('        (br_if $cmp (i32.lt_u (i32.load8_u offset=256 (local.get $j)) (i32.load8_u offset=128 (local.get $j))))  ;; below: found')
w('        (if (i32.gt_u (i32.load8_u offset=256 (local.get $j)) (i32.load8_u offset=128 (local.get $j))) (then (local.set $j (i32.const 99)) (br $cmp)))')
w('        (local.set $j (i32.add (local.get $j) (i32.const 1)))')
w('        (br_if $c (i32.lt_u (local.get $j) (i32.const 32)))')
w('      ))')
w('      (if (i32.ne (local.get $j) (i32.const 99)) (then')
w('        (i32.store (i32.const 512) (local.get $n)) (i32.store (i32.const 516) (i32.const 1))')
w('        (return (i32.add (local.get $i) (i32.const 1)))))')
w('      (local.set $n (i32.add (local.get $n) (local.get $step)))')
w('      (local.set $i (i32.add (local.get $i) (i32.const 1)))')
w('      (br_if $next (i32.lt_u (local.get $i) (local.get $count)))')
w('    ))')
w('    (local.get $count)')
w('  )')
w(')')
open('blake2b-mine.wat','w').write('\n'.join(out)+'\n'); print('wat lines', len(out))
