// in-memory Supabase stand-in for tests
(function(){
  const T = JSON.parse(localStorage.getItem('MOCK_TABLE')||'{}'); const save=()=>localStorage.setItem('MOCK_TABLE', JSON.stringify(T));
  const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
  const dm=(a,b)=>{const o={...(isObj(a)?a:{})};for(const[k,v]of Object.entries(b||{}))o[k]=isObj(v)&&isObj(o[k])?dm(o[k],v):v;return o;};
  window.MOCK = T;
  window.supabase = { createClient(){ return {
    auth:{ getSession: async()=>({data:{session:{user:{email:'qa@example.com'}}}}), signOut: async()=>{} },
    from(t){ return {
      select(){ return { range: async()=>({data:Object.entries(T).map(([path,data])=>({path,data})),error:null}), eq(_,p){ return { maybeSingle: async()=>({data: T[p]!==undefined?{data:T[p]}:null, error:null}) }; } }; },
      upsert: async(r)=>{ T[r.path]=r.data; save(); return {error:null}; },
      delete(){ return { eq: async(_,p)=>{ delete T[p]; save(); return {error:null}; } }; }
    }; },
    rpc: async(n,a)=>{ T[a.p_path]=dm(T[a.p_path],a.p_patch); save(); return {error:null}; },
    channel(){ return { on(){ return this; }, subscribe(){ return this; } }; },
    storage:{ from(){ return { upload: async()=>({error:null}) }; } }
  }; } };
})();
