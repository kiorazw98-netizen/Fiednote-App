const state = { page: "dashboard", customers: [], products: [], sales: [], expenses: [], report: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
const money = value => new Intl.NumberFormat("en-ZA", { style:"currency", currency:"ZAR" }).format(Number(value || 0));
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;
const pageNames = { dashboard:"Overview", customers:"Customers", products:"Products", sales:"Sales", expenses:"Expenses", reports:"Reports" };
const configs = {
  customers:{ title:"Customers", subtitle:"Get to know the people behind your business.", add:"Add customer", search:"Search customers...", columns:["CUSTOMER","EMAIL","PHONE","ORDERS","ADDED"], resource:"customers" },
  products:{ title:"Products", subtitle:"Keep your catalog, pricing, and stock up to date.", add:"Add product", search:"Search products...", columns:["PRODUCT","SKU","CATEGORY","PRICE","STOCK"], resource:"products" },
  sales:{ title:"Sales", subtitle:"Every order, all in one place.", add:"Record sale", search:"Search sales...", columns:["SALE","CUSTOMER","ITEMS","DATE","TOTAL"], resource:"sales" },
  expenses:{ title:"Expenses", subtitle:"Track the costs that keep your business moving.", add:"Add expense", search:"Search expenses...", columns:["DESCRIPTION","CATEGORY","DATE","AMOUNT"], resource:"expenses" }
};

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { headers:{ "Content-Type":"application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 2800);
}
async function loadData() {
  const resources = ["customers","products","sales","expenses"];
  const values = await Promise.all(resources.map(resource => api(resource)));
  resources.forEach((resource,index) => state[resource] = values[index]);
}
async function navigate(page) {
  state.page = page; $$(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.page === page));
  $("#breadcrumb").textContent = pageNames[page]; $("#sidebar").classList.remove("open");
  try {
    await loadData();
    if (page === "dashboard") renderDashboard();
    else if (page === "reports") await renderReports();
    else renderTable(page);
  } catch (error) { $("#page-content").innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}
function heading(title, subtitle, button = "") {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR BUSINESS / ${esc(title.toUpperCase())}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${button}</div>`;
}
function renderDashboard() {
  const revenue = state.sales.filter(sale => sale.sale_date >= monthStart() && sale.sale_date <= today()).reduce((sum,sale)=>sum+Number(sale.total),0);
  const expenses = state.expenses.filter(expense=>expense.expense_date>=monthStart()&&expense.expense_date<=today()).reduce((sum,item)=>sum+Number(item.amount),0);
  const lowStock = state.products.filter(product=>Number(product.stock)<=5).sort((a,b)=>a.stock-b.stock).slice(0,5);
  const cards = [
    ["Total revenue",money(revenue),"This month","↗"],
    ["Total expenses",money(expenses),"This month","↙"],
    ["Customers",state.customers.length,"In your customer book","♙"],
    ["Products",state.products.length,"Across your catalog","▦"]
  ];
  $("#page-content").innerHTML = `${heading("Good to see you","Here’s what’s happening with your business today.",`<button class="button" data-action="new-sale"><span class="plus">＋</span>New sale</button>`)}
    <div class="stats-grid">${cards.map(([label,value,note,icon])=>`<div class="stat-card"><div class="stat-top">${label}<span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-sub">${note}</div></div>`).join("")}</div>
    <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Revenue overview</h2><p>Your sales at a glance</p></div><span class="badge">Last 6 months</span></div><div class="chart-wrap"><canvas id="revenue-chart"></canvas>${state.sales.length ? "" : '<div class="chart-empty">Your sales will show up here</div>'}</div></section>
    <section class="panel"><div class="panel-heading"><div><h2>Running low</h2><p>Products with 5 or fewer in stock</p></div><button class="icon-action" data-go="products">View all →</button></div><div class="stock-list">${lowStock.length ? lowStock.map(product=>`<div class="stock-row"><div class="stock-swatch">▦</div><div class="stock-info"><strong>${esc(product.name)}</strong><span>${esc(product.sku)} · ${esc(product.category||"Uncategorized")}</span></div><span class="stock-count ${product.stock>2?"stock-good":""}">${product.stock} left</span></div>`).join("") : '<div class="empty-state">Everything is well stocked.</div>'}</div></section></div>
    <section class="table-card"><div class="table-toolbar"><div class="toolbar-title">Recent sales</div><button class="icon-action" data-go="sales">All sales →</button></div>${salesTable(state.sales.slice(0,5),false)}</section>`;
  drawChart(state.sales);
}
function drawChart(sales) {
  const canvas=$("#revenue-chart"); if(!canvas)return;
  const bounds=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
  canvas.width=bounds.width*ratio;canvas.height=bounds.height*ratio;
  const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);
  const width=bounds.width,height=bounds.height,pad={left:36,right:10,top:12,bottom:26};
  const first=new Date();first.setDate(1);first.setMonth(first.getMonth()-5);
  const months=Array.from({length:6},(_,i)=>{const d=new Date(first.getFullYear(),first.getMonth()+i,1);return{key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`,label:d.toLocaleDateString("en-US",{month:"short"})};});
  const totals=months.map(month=>sales.filter(item=>item.sale_date.startsWith(month.key)).reduce((sum,item)=>sum+Number(item.total),0));
  const max=Math.max(...totals,100),plotW=width-pad.left-pad.right,plotH=height-pad.top-pad.bottom;
  ctx.font='9px "DM Sans"';ctx.lineWidth=1;ctx.strokeStyle="#edf0ed";ctx.fillStyle="#9aa29a";
  for(let i=0;i<4;i++){const y=pad.top+plotH*i/3;ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke();ctx.fillText(money(max*(1-i/3)).replace(".00",""),0,y+3);}
  const points=totals.map((value,i)=>({x:pad.left+plotW*(i+.5)/6,y:pad.top+plotH*(1-value/max)}));
  months.forEach((month,i)=>ctx.fillText(month.label,points[i].x-9,height-5));
  if(!totals.some(Boolean))return;
  ctx.beginPath();ctx.moveTo(points[0].x,pad.top+plotH);points.forEach(p=>ctx.lineTo(p.x,p.y));ctx.lineTo(points.at(-1).x,pad.top+plotH);ctx.closePath();ctx.fillStyle="rgba(53,106,203,.09)";ctx.fill();
  ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle="#356acb";ctx.lineWidth=2;ctx.stroke();
  points.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.strokeStyle="#356acb";ctx.lineWidth=2;ctx.stroke();});
}
function salesTable(sales, actions=true) {
  return `<div class="table-scroll"><table><thead><tr><th>SALE</th><th>CUSTOMER</th><th>ITEMS</th><th>DATE</th><th>TOTAL</th>${actions?"<th></th>":""}</tr></thead><tbody>${sales.length?sales.map(sale=>`<tr><td><strong>#${String(sale.id).padStart(4,"0")}</strong></td><td>${esc(sale.customer_name)}</td><td>${sale.item_count} item${sale.item_count===1?"":"s"}</td><td>${esc(sale.sale_date)}</td><td><strong>${money(sale.total)}</strong></td>${actions?`<td><button class="icon-action" data-delete="sales" data-id="${sale.id}">Delete</button></td>`:""}</tr>`).join(""):`<tr><td class="empty-state" colspan="${actions?6:5}">No sales yet. Record your first sale to get started.</td></tr>`}</tbody></table></div>`;
}
function rowFor(page,item) {
  const actions=`<td><div class="row-actions">${page==="sales"?"":`<button class="icon-action" data-edit="${page}" data-id="${item.id}">Edit</button>`}<button class="icon-action" data-delete="${page}" data-id="${item.id}">Delete</button></div></td>`;
  if(page==="customers")return `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(item.email||"—")}</td><td>${esc(item.phone||"—")}</td><td>${item.orders}</td><td>${esc(item.created_at.slice(0,10))}</td>${actions}</tr>`;
  if(page==="products")return `<tr><td><strong>${esc(item.name)}</strong></td><td>${esc(item.sku)}</td><td>${esc(item.category||"—")}</td><td><strong>${money(item.price)}</strong></td><td><span class="badge ${item.stock<=5?"warning":""}">${item.stock} in stock</span></td>${actions}</tr>`;
  if(page==="sales")return `<tr><td><strong>#${String(item.id).padStart(4,"0")}</strong></td><td>${esc(item.customer_name)}</td><td>${item.item_count} item${item.item_count===1?"":"s"}</td><td>${esc(item.sale_date)}</td><td><strong>${money(item.total)}</strong></td>${actions}</tr>`;
  return `<tr><td><strong>${esc(item.description)}</strong></td><td><span class="badge neutral">${esc(item.category)}</span></td><td>${esc(item.expense_date)}</td><td><strong>${money(item.amount)}</strong></td>${actions}</tr>`;
}
function renderTable(page) {
  const config=configs[page],records=state[page];
  const add=`<button class="button" data-action="${page==="sales"?"new-sale":`new-${page}`}"><span class="plus">＋</span>${config.add}</button>`;
  const filters=page==="products"?`<select class="filter-select" id="category-filter"><option value="">All categories</option>${[...new Set(records.map(item=>item.category).filter(Boolean))].sort().map(category=>`<option>${esc(category)}</option>`).join("")}</select>`:
    page==="sales"||page==="expenses"?`<select class="filter-select" id="period-filter"><option value="">All time</option><option value="month">This month</option><option value="today">Today</option></select>`:"";
  $("#page-content").innerHTML=`${heading(config.title,config.subtitle,add)}<section class="table-card"><div class="table-toolbar"><div class="toolbar-title">${records.length} ${page==="sales"?"transactions":page}</div><div class="table-tools"><label class="search-wrap"><span class="search-icon">⌕</span><input class="search-input" id="table-search" placeholder="${config.search}" aria-label="${config.search}"></label>${filters}</div></div><div class="table-scroll"><table><thead><tr>${config.columns.map(column=>`<th>${column}</th>`).join("")}<th></th></tr></thead><tbody id="table-body"></tbody></table></div><div class="table-footer" id="table-footer"></div></section>`;
  const update=()=>{
    const term=$("#table-search").value.trim().toLowerCase(),category=$("#category-filter")?.value||"",period=$("#period-filter")?.value||"";
    const filtered=records.filter(item=>{
      const searchable=page==="sales"?[item.id,item.customer_name,item.sale_date,...item.items.map(product=>product.product_name)].join(" "):
        page==="products"?[item.name,item.sku,item.category].join(" "):page==="customers"?[item.name,item.email,item.phone,item.address].join(" "):[item.description,item.category,item.expense_date].join(" ");
      const date=page==="sales"?item.sale_date:item.expense_date;
      return searchable.toLowerCase().includes(term)&&(!category||item.category===category)&&(!period||date>=(period==="today"?today():monthStart()));
    });
    $("#table-body").innerHTML=filtered.length?filtered.map(item=>rowFor(page,item)).join(""):`<tr><td class="empty-state" colspan="${config.columns.length+1}">No matching ${page} found.</td></tr>`;
    $("#table-footer").textContent=`Showing ${filtered.length} of ${records.length} ${page}`;
  };
  $("#table-search").addEventListener("input",update);$("#category-filter")?.addEventListener("change",update);$("#period-filter")?.addEventListener("change",update);update();
}
async function renderReports() {
  const start=$("#report-start")?.value||monthStart(),end=$("#report-end")?.value||today();
  const report=await api(`reports?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);state.report=report;
  $("#page-content").innerHTML=`${heading("Reports","A clear picture of revenue, costs, and profitability.")}<div class="table-toolbar flush"><div class="eyebrow">REPORTING PERIOD</div><div class="report-controls"><input type="date" class="date-input" id="report-start" value="${report.start}" aria-label="Start date"><span class="muted">to</span><input type="date" class="date-input" id="report-end" value="${report.end}" aria-label="End date"><button class="button small" id="apply-report">Apply</button></div></div>
  <div class="report-summary">${[["Revenue",report.totals.revenue],["Gross profit",report.totals.gross_profit],["Expenses",report.totals.expenses],["Net profit",report.totals.net_profit]].map(([label,value])=>`<div class="report-stat"><span>${label}</span><strong>${money(value)}</strong></div>`).join("")}</div>
  <div class="report-panels"><section class="panel"><div class="panel-heading"><div><h2>Revenue by day</h2><p>${report.totals.orders} orders · ${money(report.totals.average_order)} average order</p></div></div>${report.sales_by_day.length?report.sales_by_day.map(item=>`<div class="expense-bar"><span class="expense-bar-label">${esc(item.date)}</span><div class="expense-bar-track"><div class="expense-bar-fill" style="width:${Math.max(3,Number(item.revenue)/Math.max(...report.sales_by_day.map(row=>row.revenue))*100)}%"></div></div><span class="expense-bar-value">${money(item.revenue)}</span></div>`).join(""):'<div class="empty-state">No sales for this period.</div>'}</section>
  <section class="panel"><div class="panel-heading"><div><h2>Expenses by category</h2><p>Where your money is going</p></div></div>${report.expenses_by_category.length?report.expenses_by_category.map(item=>`<div class="expense-bar"><span class="expense-bar-label">${esc(item.category)}</span><div class="expense-bar-track"><div class="expense-bar-fill" style="width:${Math.max(3,Number(item.amount)/Math.max(...report.expenses_by_category.map(row=>row.amount))*100)}%"></div></div><span class="expense-bar-value">${money(item.amount)}</span></div>`).join(""):'<div class="empty-state">No expenses for this period.</div>'}</section></div>`;
  $("#apply-report").addEventListener("click",()=>renderReports().catch(error=>toast(error.message)));
}
function field(label,name,value="",type="text",extra="") {
  return `<div class="field"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;
}
function showModal(title,subtitle,content,onSubmit,{wide=false,submitLabel="Save"}={}) {
  const root=$("#modal-root");
  root.innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?"wide":""}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="close-button" type="button" aria-label="Close">×</button></div><form id="modal-form">${content}<div class="modal-actions"><button type="button" class="button secondary" data-close>Cancel</button><button class="button" type="submit">${submitLabel}</button></div></form></section></div>`;
  root.querySelector(".close-button").onclick=()=>root.innerHTML="";
  root.querySelector("[data-close]").onclick=()=>root.innerHTML="";
  root.querySelector(".modal-backdrop").addEventListener("click",event=>{if(event.target===event.currentTarget)root.innerHTML="";});
  root.querySelector("form").addEventListener("submit",async event=>{event.preventDefault();const button=event.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{await onSubmit(new FormData(event.currentTarget));root.innerHTML="";toast("Changes saved.");await navigate(state.page);}catch(error){toast(error.message);button.disabled=false;}});
}
function formValues(form) { return Object.fromEntries(form.entries()); }
function openRecordForm(resource,record) {
  const edit=Boolean(record),id=record?.id;
  const forms={
    customers:{title:"customer",subtitle:"Add someone new to your customer book.",fields:field("Full name","name",record?.name,"text",'required')+field("Email address","email",record?.email,"email")+field("Phone number","phone",record?.phone,"tel")+`<div class="field full"><label for="field-address">Address</label><textarea id="field-address" name="address">${esc(record?.address||"")}</textarea></div>`},
    products:{title:"product",subtitle:"Add a product to your catalog and set its stock.",fields:field("Product name","name",record?.name,"text",'required')+field("SKU","sku",record?.sku,"text",'required')+field("Category","category",record?.category)+field("Selling price","price",record?.price??"","number",'required min="0" step="0.01"')+field("Unit cost","cost",record?.cost??"","number",'min="0" step="0.01"')+field("Stock quantity","stock",record?.stock??0,"number",'required min="0" step="1"')},
    expenses:{title:"expense",subtitle:"Record an expense for your business.",fields:field("Description","description",record?.description,"text",'required')+field("Category","category",record?.category||"Other")+field("Amount","amount",record?.amount??"","number",'required min="0.01" step="0.01"')+field("Date","expense_date",record?.expense_date||today(),"date",'required')}
  };
  const form=forms[resource],singular=form.title;
  showModal(`${edit?"Edit":"Add"} ${singular}`,form.subtitle,`<div class="form-grid">${form.fields}</div>`,async formData=>api(`${resource}${edit?`/${id}`:""}`,{method:edit?"PUT":"POST",body:JSON.stringify(formValues(formData))}),{submitLabel:edit?"Save changes":`Add ${singular}`});
}
function openSaleForm() {
  if(!state.products.length){toast("Add a product before recording a sale.");return;}
  const customerOptions=state.customers.map(customer=>`<option value="${customer.id}">${esc(customer.name)}</option>`).join("");
  const productOptions=state.products.map(product=>`<option value="${product.id}" data-price="${product.price}" data-stock="${product.stock}" ${product.stock===0?"disabled":""}>${esc(product.name)} · ${money(product.price)} (${product.stock} in stock)</option>`).join("");
  const content=`<div class="form-grid"><div class="field"><label for="sale-customer">Customer</label><select id="sale-customer" name="customer_id"><option value="">Walk-in customer</option>${customerOptions}</select></div><div class="field"><label for="sale-date">Sale date</label><input id="sale-date" type="date" name="sale_date" value="${today()}" required></div></div><div class="sale-lines-heading">Products</div><div id="sale-lines"></div><button type="button" class="button secondary small" id="add-sale-line">＋ Add another product</button><div class="sale-total">Sale total <strong id="sale-total">${money(0)}</strong></div>`;
  showModal("Record a sale","Add the items and customer for this order.",content,async formData=>{
    const lines=$$(".sale-line",$("#modal-root")).map(line=>({product_id:line.querySelector("select").value,quantity:line.querySelector("input").value}));
    await api("sales",{method:"POST",body:JSON.stringify({customer_id:formData.get("customer_id"),sale_date:formData.get("sale_date"),items:lines})});
  },{wide:true,submitLabel:"Record sale"});
  const lines=$("#sale-lines");
  const addLine=()=>{
    const row=document.createElement("div");row.className="sale-line";
    row.innerHTML=`<div class="field"><label>Product</label><select required><option value="">Choose a product</option>${productOptions}</select></div><div class="field"><label>Quantity</label><input type="number" min="1" value="1" required></div><button type="button" class="remove-line" aria-label="Remove product">×</button>`;
    row.querySelector(".remove-line").onclick=()=>{row.remove();calculate();};
    row.querySelectorAll("select,input").forEach(input=>input.addEventListener("change",calculate));
    lines.append(row);calculate();
  };
  const calculate=()=>{$("#sale-total").textContent=money($$(".sale-line",lines).reduce((sum,line)=>sum+Number(line.querySelector("select").selectedOptions[0]?.dataset.price||0)*Number(line.querySelector("input").value||0),0));};
  $("#add-sale-line").onclick=addLine;addLine();
}
async function deleteRecord(resource,id) {
  if(!confirm("Delete this record? This action cannot be undone."))return;
  try{await api(`${resource}/${id}`,{method:"DELETE"});toast("Record deleted.");await navigate(state.page);}catch(error){toast(error.message);}
}
document.addEventListener("click",event=>{
  const nav=event.target.closest("[data-page]");if(nav){navigate(nav.dataset.page);return;}
  const action=event.target.closest("[data-action]")?.dataset.action;
  if(action==="new-sale")return openSaleForm();
  if(action?.startsWith("new-"))return openRecordForm(action.slice(4));
  const go=event.target.closest("[data-go]");if(go)return navigate(go.dataset.go);
  const edit=event.target.closest("[data-edit]");if(edit){const resource=edit.dataset.edit;return openRecordForm(resource,state[resource].find(item=>item.id===Number(edit.dataset.id)));}
  const remove=event.target.closest("[data-delete]");if(remove)deleteRecord(remove.dataset.delete,remove.dataset.id);
});
$("#menu-button").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
$("#today-label").textContent=new Intl.DateTimeFormat("en-US",{weekday:"short",month:"short",day:"numeric"}).format(new Date());
window.addEventListener("resize",()=>{if(state.page==="dashboard")drawChart(state.sales);});
navigate("dashboard");
