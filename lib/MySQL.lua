local promise = promise
local Await = Citizen.Await
local resourceName = GetCurrentResourceName()
local GetResourceState = GetResourceState
local type = type

local oxmysql = exports.oxmysql

local function isCallable(value)
	local valueType = type(value)
	return valueType == 'function' or (valueType == 'table' and value.__cfx_functionReference ~= nil)
end

---@param query string | table
---@param parameters? table | function
---@param cb? function
---@param transaction? boolean
local function safeArgs(query, parameters, cb, transaction)
	local queryType = type(query)

	if transaction then
		if queryType ~= 'table' then
			error(("First argument expected table, received '%s'"):format(queryType), 3)
		end
	elseif queryType ~= 'string' then
		error(("First argument expected string, received '%s'"):format(queryType), 3)
	end

	if parameters ~= nil then
		if isCallable(parameters) then
			cb = parameters
			parameters = nil
		elseif type(parameters) ~= 'table' then
			error(("Second argument expected table or function, received '%s'"):format(type(parameters)), 3)
		end
	end

	if cb ~= nil and not isCallable(cb) then
		error(("Third argument expected function, received '%s'"):format(type(cb)), 3)
	end

	return query, parameters, cb
end

local function await(method, query, parameters)
	local p = promise.new()

	oxmysql[method](nil, query, parameters, function(result, err)
		if err then
			return p:reject(err)
		end

		p:resolve(result)
	end, resourceName, true)

	return Await(p)
end

local mysql_method_mt = {
	-- callback style: cb(result, err); err is set and result is nil when the query failed
	__call = function(self, query, parameters, cb)
		query, parameters, cb = safeArgs(query, parameters, cb, self.method == 'transaction')
		return oxmysql[self.method](nil, query, parameters, cb, resourceName, false)
	end
}

local MySQL = MySQL or {}

for _, method in ipairs({ 'scalar', 'single', 'query', 'insert', 'update', 'prepare', 'transaction', 'rawExecute' }) do
	local isTransaction = method == 'transaction'

	MySQL[method] = setmetatable({
		method = method,
		await = function(query, parameters)
			query, parameters = safeArgs(query, parameters, nil, isTransaction)
			return await(method, query, parameters)
		end
	}, mysql_method_mt)
end

local function onReady(cb)
	while GetResourceState('oxmysql') ~= 'started' do
		Wait(50)
	end

	oxmysql:awaitConnection()

	return cb and cb() or true
end

MySQL.ready = setmetatable({
	await = onReady
}, {
	__call = function(_, cb)
		Citizen.CreateThreadNow(function() onReady(cb) end)
	end,
})

function MySQL.isReady()
	return oxmysql:isReady()
end

---Runs `cb(query)` inside a transaction. Return false (or error) to roll back.
---@param cb fun(query: fun(sql: string, parameters?: table): any): boolean?
---@return boolean
function MySQL.startTransaction(cb)
	return oxmysql:startTransaction(cb, resourceName)
end

_ENV.MySQL = MySQL
